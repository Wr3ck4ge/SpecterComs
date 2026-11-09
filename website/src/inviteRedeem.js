// One invite redemption per code per page load. /join/:code redeems from an
// effect, and StrictMode (dev) mounts → unmounts → remounts it, so the effect
// runs twice; a remount after login can run it again. Every caller for the
// same code gets the same in-flight/settled promise. A failed attempt is
// forgotten so the user can retry; the server is idempotent as well
// (already a member → 200, no second use consumed).
const attempts = new Map();

export function redeemInviteOnce(redeem, code) {
  if (!attempts.has(code)) {
    const p = Promise.resolve()
      .then(() => redeem(code))
      .then((res) => {
        if (res?.error) attempts.delete(code);
        return res;
      }, (err) => {
        attempts.delete(code);
        throw err;
      });
    attempts.set(code, p);
  }
  return attempts.get(code);
}

/** Test hook. */
export function _resetInviteAttempts() {
  attempts.clear();
}
