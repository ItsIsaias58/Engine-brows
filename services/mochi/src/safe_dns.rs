use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{OnceLock, RwLock};
use std::time::{Duration, Instant};

// CACHÉ DNS: el resolutor no cacheaba y cada conexion nueva a un host pagaba
// lookup; una pagina con decenas de sub-recursos externos acumulaba cientos
// de ms. TTL corto para no pisar cambios de IP de CDNs.
const DNS_TTL: Duration = Duration::from_secs(300);
const DNS_MAX_ENTRIES: usize = 1024;

type DnsCache = HashMap<String, (Vec<SocketAddr>, Instant)>;

fn dns_cache() -> &'static RwLock<DnsCache> {
    static CACHE: OnceLock<RwLock<DnsCache>> = OnceLock::new();
    CACHE.get_or_init(|| RwLock::new(HashMap::new()))
}

#[derive(Clone, Default)]
pub struct PublicDnsResolver;

impl Resolve for PublicDnsResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_owned();
        Box::pin(async move {
            validate_hostname(&host)?;
            // 1) acierto de caché (solo se guardan IPs ya validadas como publicas)
            {
                let cache = dns_cache().read().unwrap_or_else(|e| e.into_inner());
                if let Some((addresses, at)) = cache.get(&host) {
                    if at.elapsed() < DNS_TTL {
                        let addresses = addresses.clone();
                        return Ok(Box::new(addresses.into_iter()) as Addrs);
                    }
                }
            }
            let addresses = tokio::net::lookup_host((host.as_str(), 0)).await?;
            let addresses = addresses.collect::<Vec<_>>();
            if addresses.is_empty() {
                return Err(io::Error::new(
                    io::ErrorKind::NotFound,
                    "host has no addresses... /ᐠ - ˕ -マ",
                )
                .into());
            }
            if addresses.iter().any(|address| !is_public_ip(address.ip())) {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "host resolves to a non-public address... /ᐠ - ˕ -マ",
                )
                .into());
            }
            // 2) guardar en caché
            {
                let mut cache = dns_cache().write().unwrap_or_else(|e| e.into_inner());
                if cache.len() >= DNS_MAX_ENTRIES {
                    cache.clear();
                }
                cache.insert(host, (addresses.clone(), Instant::now()));
            }
            Ok(Box::new(addresses.into_iter()) as Addrs)
        })
    }
}

pub fn validate_public_target(url: &url::Url) -> Result<(), &'static str> {
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("unsupported target scheme... /ᐠ - ˕ -マ");
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("target credentials are not allowed... /ᐠ - ˕ -マ");
    }

    let port = url
        .port_or_known_default()
        .ok_or("target port is missing... /ᐠ - ˕ -マ")?;
    if port != 80 && port != 443 && port < 1024 {
        return Err("privileged target port is not allowed... /ᐠ - ˕ -マ");
    }

    let host = url
        .host_str()
        .ok_or("target host is missing... /ᐠ - ˕ -マ")?;
    validate_hostname(host).map_err(|_| "reserved target hostname... /ᐠ - ˕ -マ")?;

    host.parse::<IpAddr>()
        .map(|ip| {
            is_public_ip(ip)
                .then_some(())
                .ok_or("target address is not public... /ᐠ - ˕ -マ")
        })
        .unwrap_or(Ok(()))
}

pub async fn validate_public_target_dns(url: &url::Url) -> Result<(), &'static str> {
    validate_public_target(url)?;
    let port = url
        .port_or_known_default()
        .ok_or("target port is missing... /ᐠ - ˕ -マ")?;
    let host = url
        .host_str()
        .ok_or("target host is missing... /ᐠ - ˕ -マ")?;
    if host.parse::<IpAddr>().is_ok() {
        return Ok(());
    }

    let addresses = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| "target dns lookup failed... /ᐠ - ˕ -マ")?
        .collect::<Vec<SocketAddr>>();
    if addresses.is_empty() {
        return Err("target host has no addresses... /ᐠ - ˕ -マ");
    }
    if addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err("target host resolves to a non-public address... /ᐠ - ˕ -マ");
    }
    Ok(())
}

fn validate_hostname(host: &str) -> io::Result<()> {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty()
        || host == "localhost"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host.ends_with(".home.arpa")
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "reserved hostname... /ᐠ - ˕ -マ",
        ));
    }
    Ok(())
}

pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_public_ipv4(ip),
        IpAddr::V6(ip) => is_public_ipv6(ip),
    }
}

fn is_public_ipv4(ip: Ipv4Addr) -> bool {
    let octets = ip.octets();
    !(ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_unspecified()
        || ip.is_multicast()
        || octets[0] == 0
        || octets[0] >= 240
        || (octets[0] == 100 && (64..=127).contains(&octets[1]))
        || (octets[0] == 198 && (18..=19).contains(&octets[1]))
        || (octets[0] == 192
            && octets[1] == 0
            && octets[2] == 0
            && octets[3] != 9
            && octets[3] != 10))
}

fn is_public_ipv6(ip: Ipv6Addr) -> bool {
    if ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_unique_local()
        || ip.is_unicast_link_local()
        || ip.is_multicast()
    {
        return false;
    }
    let segments = ip.segments();
    if segments[0] == 0x2001 && segments[1] == 0x0db8 {
        return false;
    }
    if segments[0] == 0x2001 && segments[1] == 0 {
        return false; // Teredo 2001::/32
    }
    if segments[0] == 0x2002 {
        return false; // 6to4 2002::/16
    }
    if segments[0] == 0x64 && segments[1] == 0xff9b {
        return false; // well-known NAT64 64:ff9b::/96
    }
    // to_ipv4() y no to_ipv4_mapped(): la forma IPv4-compatible (::a.b.c.d,
    // RFC 4291 §2.5.5.2) tambien colapsa a IPv4, y to_ipv4_mapped() solo ve la
    // forma ::ffff:a.b.c.d. sin esto "::127.0.0.1" pasaba por todas las
    // comprobaciones de prefijo y salia clasificado como publica.
    if let Some(ipv4) = ip.to_ipv4() {
        return is_public_ipv4(ipv4);
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_public_addresses() {
        for address in [
            "127.0.0.1",
            "10.0.0.1",
            "169.254.169.254",
            "100.64.0.1",
            "198.18.0.1",
            "192.0.0.1",
            "192.0.0.8",
            "::1",
            "fd00::1",
            "fe80::1",
            "2001:db8::1",
            "2001::1",
            "2002:c000:0204::1",
            "64:ff9b::1",
            "::ffff:127.0.0.1",
            // IPv4-compatible: colapsa a 127.0.0.1 pero to_ipv4_mapped() no la ve
            "::127.0.0.1",
            "::7f00:1",
            "::10.0.0.1",
            "::a00:1",
        ] {
            assert!(!is_public_ip(address.parse().unwrap()), "{address}");
        }
    }

    #[test]
    fn accepts_public_addresses() {
        for address in [
            "1.1.1.1",
            "8.8.8.8",
            "192.0.0.9",
            "192.0.0.10",
            "2606:4700:4700::1111",
        ] {
            assert!(is_public_ip(address.parse().unwrap()), "{address}");
        }
    }
}
