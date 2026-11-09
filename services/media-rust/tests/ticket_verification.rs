//! Media ticket verification: ES256 (MEDIA_TICKET_PUBLIC_KEY) and the legacy
//! HS256 (JWT_SECRET) path.

use base64::Engine as _;
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use media_sfu::ticket::{TicketError, TicketVerifier, MEDIA_TICKET_AUD, MEDIA_TICKET_KID};
use serde_json::{json, Value};

const SECRET: &str = "test-jwt-secret-not-prod";

struct Keys {
    private_pem: String,
    public_pem: String,
}

fn p256_keys() -> Keys {
    let kp = rcgen::KeyPair::generate_for(&rcgen::PKCS_ECDSA_P256_SHA256).unwrap();
    Keys { private_pem: kp.serialize_pem(), public_pem: kp.public_key_pem() }
}

fn now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()
}

/// The claims identity-node's media-ticket endpoint signs, plus aud.
fn ticket_claims() -> Value {
    json!({
        "sub": "user-1",
        "org_id": "org-1",
        "channel_id": "chan-1",
        "callsign": "Alpha",
        "purpose": "media_voice",
        "media_role": "voice",
        "voice_relay": true,
        "client_version": "2.0.0",
        "jti": "8d6f6c1e-0000-4000-8000-000000000000",
        "aud": MEDIA_TICKET_AUD,
        "iat": now(),
        "exp": now() + 90,
    })
}

fn es256(keys: &Keys, kid: Option<&str>, claims: &Value) -> String {
    let mut h = Header::new(Algorithm::ES256);
    h.kid = kid.map(str::to_string);
    encode(&h, claims, &EncodingKey::from_ec_pem(keys.private_pem.as_bytes()).unwrap()).unwrap()
}

fn hs256(secret: &[u8], claims: &Value) -> String {
    encode(&Header::new(Algorithm::HS256), claims, &EncodingKey::from_secret(secret)).unwrap()
}

fn with(mut claims: Value, k: &str, v: Value) -> Value {
    claims[k] = v;
    claims
}

fn without(mut claims: Value, k: &str) -> Value {
    claims.as_object_mut().unwrap().remove(k);
    claims
}

// ── ES256 ────────────────────────────────────────────────────────────────────

#[test]
fn es256_valid_ticket_is_accepted_with_all_claims() {
    let k = p256_keys();
    let v = TicketVerifier::new(Some(&k.public_pem), None).unwrap();
    let claims = v.verify(&es256(&k, Some(MEDIA_TICKET_KID), &ticket_claims())).unwrap();
    assert_eq!(claims["sub"], "user-1");
    assert_eq!(claims["purpose"], "media_voice");
    assert_eq!(claims["voice_relay"], true);
}

#[test]
fn es256_aud_may_be_an_array_containing_specter_media() {
    let k = p256_keys();
    let v = TicketVerifier::new(Some(&k.public_pem), None).unwrap();
    let c = with(ticket_claims(), "aud", json!(["other", MEDIA_TICKET_AUD]));
    assert!(v.verify(&es256(&k, Some(MEDIA_TICKET_KID), &c)).is_ok());
}

#[test]
fn es256_wrong_or_missing_aud_is_rejected() {
    let k = p256_keys();
    let v = TicketVerifier::new(Some(&k.public_pem), None).unwrap();
    let wrong = with(ticket_claims(), "aud", json!("specter-api"));
    assert!(matches!(v.verify(&es256(&k, Some(MEDIA_TICKET_KID), &wrong)), Err(TicketError::Invalid(_))));
    let missing = without(ticket_claims(), "aud");
    assert!(v.verify(&es256(&k, Some(MEDIA_TICKET_KID), &missing)).is_err());
}

#[test]
fn es256_wrong_or_missing_kid_is_rejected() {
    let k = p256_keys();
    let v = TicketVerifier::new(Some(&k.public_pem), None).unwrap();
    assert_eq!(
        v.verify(&es256(&k, Some("media-v2"), &ticket_claims())).unwrap_err(),
        TicketError::WrongKid(Some("media-v2".into()))
    );
    assert_eq!(v.verify(&es256(&k, None, &ticket_claims())).unwrap_err(), TicketError::WrongKid(None));
}

#[test]
fn es256_expired_or_exp_less_ticket_is_rejected() {
    let k = p256_keys();
    let v = TicketVerifier::new(Some(&k.public_pem), None).unwrap();
    let expired = with(ticket_claims(), "exp", json!(now() - 1));
    assert_eq!(v.verify(&es256(&k, Some(MEDIA_TICKET_KID), &expired)).unwrap_err(), TicketError::Expired);
    let at_exp = with(ticket_claims(), "exp", json!(now()));
    assert_eq!(v.verify(&es256(&k, Some(MEDIA_TICKET_KID), &at_exp)).unwrap_err(), TicketError::Expired);
    let no_exp = without(ticket_claims(), "exp");
    assert!(v.verify(&es256(&k, Some(MEDIA_TICKET_KID), &no_exp)).is_err());
}

#[test]
fn es256_signed_by_another_key_is_rejected() {
    let (k, attacker) = (p256_keys(), p256_keys());
    let v = TicketVerifier::new(Some(&k.public_pem), None).unwrap();
    assert!(matches!(
        v.verify(&es256(&attacker, Some(MEDIA_TICKET_KID), &ticket_claims())),
        Err(TicketError::Invalid(_))
    ));
}

#[test]
fn es256_tampered_payload_is_rejected() {
    let k = p256_keys();
    let v = TicketVerifier::new(Some(&k.public_pem), None).unwrap();
    let token = es256(&k, Some(MEDIA_TICKET_KID), &ticket_claims());
    let parts: Vec<&str> = token.split('.').collect();
    let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let forged = b64.encode(serde_json::to_vec(&with(ticket_claims(), "sub", json!("admin"))).unwrap());
    assert!(v.verify(&format!("{}.{}.{}", parts[0], forged, parts[2])).is_err());
}

#[test]
fn es256_rejected_when_only_the_legacy_secret_is_configured() {
    let k = p256_keys();
    let v = TicketVerifier::new(None, Some(SECRET)).unwrap();
    assert!(matches!(
        v.verify(&es256(&k, Some(MEDIA_TICKET_KID), &ticket_claims())),
        Err(TicketError::AlgorithmNotAccepted(_))
    ));
}

#[test]
fn public_key_pem_with_escaped_newlines_is_accepted() {
    // The shape a PEM takes in a one-line .env value.
    let k = p256_keys();
    let one_line = k.public_pem.trim().replace('\n', "\\n");
    let v = TicketVerifier::new(Some(&one_line), None).unwrap();
    assert!(v.verify(&es256(&k, Some(MEDIA_TICKET_KID), &ticket_claims())).is_ok());
}

// ── HS256 while only the public key is configured ───────────────────────────

#[test]
fn hs256_rejected_when_only_the_public_key_is_configured() {
    let k = p256_keys();
    let v = TicketVerifier::new(Some(&k.public_pem), None).unwrap();
    assert!(!v.accepts_legacy_hs256());
    assert!(matches!(
        v.verify(&hs256(SECRET.as_bytes(), &ticket_claims())),
        Err(TicketError::AlgorithmNotAccepted(_))
    ));
}

#[test]
fn hs256_signed_with_the_public_key_bytes_is_rejected() {
    // Classic alg-confusion: an attacker who knows the (public) verification
    // key HMACs a token with it. The public key must never be an HMAC key.
    let k = p256_keys();
    let forged = hs256(k.public_pem.as_bytes(), &ticket_claims());
    let only_pub = TicketVerifier::new(Some(&k.public_pem), None).unwrap();
    assert!(only_pub.verify(&forged).is_err());
    let both = TicketVerifier::new(Some(&k.public_pem), Some(SECRET)).unwrap();
    assert!(both.verify(&forged).is_err());
}

// ── Legacy HS256 ─────────────────────────────────────────────────────────────

#[test]
fn legacy_hs256_ticket_without_aud_is_accepted() {
    // What identity-node signs today: HS256, JWT_SECRET, no aud, no kid.
    let v = TicketVerifier::new(None, Some(SECRET)).unwrap();
    let claims = v.verify(&hs256(SECRET.as_bytes(), &without(ticket_claims(), "aud"))).unwrap();
    assert_eq!(claims["purpose"], "media_voice");
}

#[test]
fn legacy_hs256_wrong_secret_or_expired_is_rejected() {
    let v = TicketVerifier::new(None, Some(SECRET)).unwrap();
    assert!(matches!(v.verify(&hs256(b"other-secret", &ticket_claims())), Err(TicketError::Invalid(_))));
    let expired = with(ticket_claims(), "exp", json!(now() - 1));
    assert_eq!(v.verify(&hs256(SECRET.as_bytes(), &expired)).unwrap_err(), TicketError::Expired);
    let no_exp = without(ticket_claims(), "exp");
    assert_eq!(v.verify(&hs256(SECRET.as_bytes(), &no_exp)).unwrap_err(), TicketError::Expired);
}

#[test]
fn both_schemes_accepted_during_rollout() {
    let k = p256_keys();
    let v = TicketVerifier::new(Some(&k.public_pem), Some(SECRET)).unwrap();
    assert!(v.accepts_es256() && v.accepts_legacy_hs256());
    assert!(v.verify(&es256(&k, Some(MEDIA_TICKET_KID), &ticket_claims())).is_ok());
    assert!(v.verify(&hs256(SECRET.as_bytes(), &ticket_claims())).is_ok());
}

// ── Neither / garbage ────────────────────────────────────────────────────────

#[test]
fn refuses_to_start_without_any_verification_key() {
    assert!(TicketVerifier::new(None, None).is_err());
    assert!(TicketVerifier::new(Some(""), Some("")).is_err());
}

#[test]
fn alg_none_and_garbage_are_rejected_without_panicking() {
    let k = p256_keys();
    let v = TicketVerifier::new(Some(&k.public_pem), Some(SECRET)).unwrap();
    let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    let none_header = b64.encode(br#"{"alg":"none","typ":"JWT"}"#);
    let body = b64.encode(serde_json::to_vec(&ticket_claims()).unwrap());
    for t in [
        format!("{}.{}.", none_header, body),
        format!("{}.{}", none_header, body),
        String::new(),
        "...".into(),
        "a.b.c".into(),
        "eyJhbGciOiJFUzI1NiJ9.e30.".into(),
        "\u{0}\u{1F980}".into(),
        "x".repeat(10_000),
    ] {
        assert!(v.verify(&t).is_err(), "{t:?} must be rejected");
    }
}
