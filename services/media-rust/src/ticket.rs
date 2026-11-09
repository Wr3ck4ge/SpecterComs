//! Media ticket verification.
//!
//! identity-node mints a short-lived (90 s) *media ticket* per WebTransport
//! connection (`POST /orgs/:id/media-ticket`, orgController.ts) — not the
//! user's access token: every handler also requires `purpose` =
//! `media_voice` / `media_video`, which access tokens don't carry.
//!
//! Two signing schemes are accepted, chosen by the token header's `alg`:
//!
//! * **ES256** (the target): verified with `MEDIA_TICKET_PUBLIC_KEY` (PEM).
//!   The header `kid` must be [`MEDIA_TICKET_KID`] and the `aud` claim must
//!   be [`MEDIA_TICKET_AUD`]. A node holding only the public key can't mint
//!   anything, so root on a media node no longer means forging tickets — or
//!   access tokens — for every user.
//! * **HS256** (legacy, rollout only): verified with `JWT_SECRET`, exactly as
//!   before (signature, then `exp` fail-closed). Only accepted while
//!   JWT_SECRET is set; once identity-node signs ES256 everywhere, remove
//!   JWT_SECRET from the node env and this path switches off.
//!
//! Both paths require `exp` and reject a token at or past it, no leeway.
//! Any other `alg` (including `none`) is rejected.

use std::collections::BTreeMap;
use std::env;
use std::fmt;

use hmac::{Hmac, Mac};
use jwt::VerifyWithKey;
use serde_json::Value;
use sha2::Sha256;

pub const MEDIA_TICKET_KID: &str = "media-v1";
pub const MEDIA_TICKET_AUD: &str = "specter-media";

pub type Claims = BTreeMap<String, Value>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TicketError {
    /// Not a parseable JWT / bad header.
    Malformed(String),
    /// `alg` this relay doesn't accept (or isn't configured for).
    AlgorithmNotAccepted(String),
    /// ES256 token whose `kid` isn't media-v1.
    WrongKid(Option<String>),
    /// Signature (or claim validation such as `aud`) failed.
    Invalid(String),
    /// `exp` missing or in the past.
    Expired,
}

impl fmt::Display for TicketError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TicketError::Malformed(e) => write!(f, "malformed token: {}", e),
            TicketError::AlgorithmNotAccepted(a) => write!(f, "algorithm {} not accepted", a),
            TicketError::WrongKid(k) => write!(f, "unexpected kid {:?} (want {:?})", k, MEDIA_TICKET_KID),
            TicketError::Invalid(e) => write!(f, "{}", e),
            TicketError::Expired => write!(f, "expired"),
        }
    }
}

impl std::error::Error for TicketError {}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// `verify_with_key` only checks the HMAC signature — it does not check the `exp`
/// claim at all. identity-node mints media tokens with a deliberate short lifetime
/// as the actual access-control boundary; without this check that lifetime is
/// meaningless and a captured/replayed token works forever.
/// Fails closed: a token with no `exp` claim is treated as expired.
pub fn is_token_expired(claims: &Claims) -> bool {
    is_token_expired_at(claims, now_secs())
}

fn is_token_expired_at(claims: &Claims, now: u64) -> bool {
    match claims.get("exp").and_then(|v| v.as_u64()) {
        Some(exp) => now >= exp,
        None => true,
    }
}

pub struct TicketVerifier {
    es256: Option<jsonwebtoken::DecodingKey>,
    legacy_hs256: Option<Hmac<Sha256>>,
}

impl TicketVerifier {
    /// `public_key_pem`: an SPKI `-----BEGIN PUBLIC KEY-----` P-256 key.
    /// Literal `\n` sequences are accepted in place of newlines, since a PEM
    /// usually travels through a one-line `.env` value.
    /// `jwt_secret`: the legacy HS256 secret. Empty strings count as unset.
    /// At least one must be given.
    pub fn new(public_key_pem: Option<&str>, jwt_secret: Option<&str>) -> Result<Self, String> {
        let public_key_pem = public_key_pem.map(str::trim).filter(|s| !s.is_empty());
        let jwt_secret = jwt_secret.filter(|s| !s.is_empty());

        let es256 = match public_key_pem {
            Some(pem) => {
                let pem = pem.replace("\\n", "\n");
                Some(jsonwebtoken::DecodingKey::from_ec_pem(pem.as_bytes()).map_err(|e| {
                    format!("MEDIA_TICKET_PUBLIC_KEY is not a valid P-256 public key PEM: {}", e)
                })?)
            }
            None => None,
        };
        let legacy_hs256 = match jwt_secret {
            Some(s) => Some(Hmac::<Sha256>::new_from_slice(s.as_bytes()).map_err(|_| "Invalid JWT_SECRET".to_string())?),
            None => None,
        };
        if es256.is_none() && legacy_hs256.is_none() {
            return Err(
                "Neither MEDIA_TICKET_PUBLIC_KEY nor JWT_SECRET is set — refusing to start without a way to \
                 verify media tickets. Set MEDIA_TICKET_PUBLIC_KEY (ES256, preferred) or the legacy JWT_SECRET."
                    .to_string(),
            );
        }
        Ok(TicketVerifier { es256, legacy_hs256 })
    }

    pub fn from_env() -> Result<Self, String> {
        let public_key = env::var("MEDIA_TICKET_PUBLIC_KEY").ok();
        let secret = env::var("JWT_SECRET").ok();
        Self::new(public_key.as_deref(), secret.as_deref())
    }

    pub fn accepts_es256(&self) -> bool { self.es256.is_some() }
    pub fn accepts_legacy_hs256(&self) -> bool { self.legacy_hs256.is_some() }

    /// Verify a media ticket and return its claims. Does NOT check
    /// `purpose`/`channel_id`/etc. — the connection handlers do that, the
    /// same for both schemes.
    pub fn verify(&self, token: &str) -> Result<Claims, TicketError> {
        let header = jsonwebtoken::decode_header(token).map_err(|e| TicketError::Malformed(e.to_string()))?;
        match header.alg {
            jsonwebtoken::Algorithm::ES256 => {
                let key = self.es256.as_ref()
                    .ok_or_else(|| TicketError::AlgorithmNotAccepted("ES256 (MEDIA_TICKET_PUBLIC_KEY not set)".into()))?;
                if header.kid.as_deref() != Some(MEDIA_TICKET_KID) {
                    return Err(TicketError::WrongKid(header.kid));
                }
                let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::ES256);
                validation.set_audience(&[MEDIA_TICKET_AUD]);
                validation.set_required_spec_claims(&["exp", "aud"]);
                validation.leeway = 0;
                let data = jsonwebtoken::decode::<Claims>(token, key, &validation).map_err(|e| {
                    match e.kind() {
                        jsonwebtoken::errors::ErrorKind::ExpiredSignature => TicketError::Expired,
                        _ => TicketError::Invalid(e.to_string()),
                    }
                })?;
                // Same exp boundary as the legacy path (jsonwebtoken lets a
                // token through for the second at exactly `exp`).
                if is_token_expired(&data.claims) {
                    return Err(TicketError::Expired);
                }
                Ok(data.claims)
            }
            jsonwebtoken::Algorithm::HS256 => {
                let key = self.legacy_hs256.as_ref()
                    .ok_or_else(|| TicketError::AlgorithmNotAccepted("HS256 (legacy JWT_SECRET not set)".into()))?;
                let claims: Claims = token.verify_with_key(key).map_err(|e| TicketError::Invalid(e.to_string()))?;
                if is_token_expired(&claims) {
                    return Err(TicketError::Expired);
                }
                Ok(claims)
            }
            other => Err(TicketError::AlgorithmNotAccepted(format!("{:?}", other))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn exp_is_fail_closed_with_no_leeway() {
        let mut c = Claims::new();
        assert!(is_token_expired_at(&c, 100), "no exp = expired");
        c.insert("exp".into(), json!(100));
        assert!(is_token_expired_at(&c, 100));
        assert!(!is_token_expired_at(&c, 99));
        c.insert("exp".into(), json!("100"));
        assert!(is_token_expired_at(&c, 0), "non-numeric exp = expired");
    }

    #[test]
    fn refuses_to_build_without_any_key() {
        assert!(TicketVerifier::new(None, None).is_err());
        assert!(TicketVerifier::new(Some("  "), Some("")).is_err());
        assert!(TicketVerifier::new(Some("not a pem"), Some("secret")).is_err(), "a bad public key is an error, not ignored");
        let v = TicketVerifier::new(None, Some("secret")).unwrap();
        assert!(v.accepts_legacy_hs256() && !v.accepts_es256());
    }
}
