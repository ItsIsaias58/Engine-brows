use crate::NEGATIVE;
use axum::extract::ws::{CloseFrame, Message, WebSocket};
use axum::http::HeaderMap;
use futures_util::{
    sink::SinkExt,
    stream::{SplitSink, StreamExt},
};
use std::time::Duration;
use tokio::time::timeout;
use tokio_tungstenite::{
    connect_async,
    tungstenite::{handshake::client::generate_key, protocol::Message as TungsteniteMessage},
};
use url::Url;

// Un upstream que no contesta (ni acepta ni rechaza) dejaba la conexion del
// cliente colgada para siempre. El handshake de WebSocket es rapido o no es.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
// 1011 "internal error" es lo que corresponde cuando el problema esta del lado
// de arriba (502, DNS caido, timeout), y le dice al navegador que puede
// reconectar en vez de tratarlo como un corte de red.
const UPSTREAM_CLOSE_CODE: u16 = 1011;

/// Cierra la conexion del cliente con codigo y motivo.
///
/// Sin esto, cuando `connect_async` fallaba el socket se soltaba de golpe: el
/// navegador veia un cierre anormal (ECONNRESET) en vez de un `onclose` limpio,
/// y el relayer de node registraba `websocket forwarding failed` en cada
/// reintento de la pagina. Con un frame de cierre el cliente sabe QUE paso y
/// puede decidir si reintenta.
async fn close_client(
    sender: &mut SplitSink<WebSocket, Message>,
    code: u16,
    reason: &'static str,
) {
    let _ = sender
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.into(),
        })))
        .await;
}

pub async fn handle_socket(client_socket: WebSocket, target_url: String, headers: HeaderMap) {
    let (mut client_sender, mut client_receiver) = client_socket.split();

    let mut request = axum::http::Request::builder().uri(&target_url);
    request = request.header("Sec-WebSocket-Key", generate_key());
    request = request.header("Sec-WebSocket-Version", "13");
    request = request.header("Connection", "Upgrade");
    request = request.header("Upgrade", "websocket");

    if let Ok(u) = Url::parse(&target_url) {
        if let Some(host) = u.host_str() {
            request = request.header("Host", host);
        }
        let origin = u.origin().ascii_serialization();
        request = request.header("Origin", origin);
    }

    for (k, v) in headers.iter() {
        let key = k.as_str();
        if key.eq_ignore_ascii_case("sec-websocket-protocol")
            || key.eq_ignore_ascii_case("cookie")
            || key.eq_ignore_ascii_case("authorization")
        {
            request = request.header(k, v);
        }
    }

    let request = request.body(()).unwrap();

    let (ws_stream, _) = match timeout(CONNECT_TIMEOUT, connect_async(request)).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            tracing::warn!("websocket connection failed: {}{}", e, NEGATIVE);
            close_client(
                &mut client_sender,
                UPSTREAM_CLOSE_CODE,
                "upstream websocket unavailable",
            )
            .await;
            return;
        }
        Err(_) => {
            tracing::warn!(
                "websocket connection timed out after {:?}{}",
                CONNECT_TIMEOUT,
                NEGATIVE
            );
            close_client(
                &mut client_sender,
                UPSTREAM_CLOSE_CODE,
                "upstream websocket timed out",
            )
            .await;
            return;
        }
    };

    let (mut upstream_sender, mut upstream_receiver) = ws_stream.split();

    let client_to_upstream = async move {
        while let Some(msg) = client_receiver.next().await {
            if let Ok(msg) = msg {
                let tungstenite_msg = match msg {
                    Message::Text(t) => TungsteniteMessage::Text(t),
                    Message::Binary(b) => TungsteniteMessage::Binary(b),
                    Message::Ping(b) => TungsteniteMessage::Ping(b),
                    Message::Pong(b) => TungsteniteMessage::Pong(b),
                    Message::Close(_) => TungsteniteMessage::Close(None),
                };
                if upstream_sender.send(tungstenite_msg).await.is_err() {
                    break;
                }
            } else {
                break;
            }
        }
    };

    let upstream_to_client = async move {
        while let Some(msg) = upstream_receiver.next().await {
            if let Ok(msg) = msg {
                let axum_msg = match msg {
                    TungsteniteMessage::Text(t) => Message::Text(t),
                    TungsteniteMessage::Binary(b) => Message::Binary(b),
                    TungsteniteMessage::Ping(b) => Message::Ping(b),
                    TungsteniteMessage::Pong(b) => Message::Pong(b),
                    TungsteniteMessage::Close(_) => Message::Close(None),
                    TungsteniteMessage::Frame(_) => continue,
                };
                if client_sender.send(axum_msg).await.is_err() {
                    return;
                }
            } else {
                break;
            }
        }
        // el upstream termino sin un frame de cierre (o con error): cerramos el
        // cliente con codigo en vez de dejar que se corte a lo bruto, para que
        // su `onclose` sea limpio y pueda reconectar.
        close_client(&mut client_sender, UPSTREAM_CLOSE_CODE, "upstream closed").await;
    };

    tokio::select! {
        _ = client_to_upstream => {}
        _ = upstream_to_client => {}
    }
}
