#[derive(Clone)]
pub struct IsaoConfig {
    pub port: u16,
    pub host: String,
}

impl IsaoConfig {
    pub fn from_env() -> Self {
        let port = std::env::var("ISAO_PORT")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(4003);

        // loopback por defecto: solo lyra (misma maquina) consume esta api.
        // 0.0.0.0 la exponia sin auth a toda la LAN.
        let host = std::env::var("ISAO_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());

        Self { port, host }
    }
}
