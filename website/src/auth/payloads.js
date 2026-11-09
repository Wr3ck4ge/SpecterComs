// Request bodies for /auth/login and /auth/register. Deliberately no hardware
// id field — a browser has none, and the shared placeholder the website used to
// send made every browser user the same "device" to the hardware-ban list.
// identity-node ignores anything that isn't a real desktop hardware id anyway.

export function buildLoginPayload(form) {
  return { email: form.email, password: form.password };
}

export function buildRegisterPayload(form, timezone) {
  const payload = { callsign: form.callsign, email: form.email, password: form.password, timezone };
  if (form.global_tag) payload.global_tag = form.global_tag;
  return payload;
}
