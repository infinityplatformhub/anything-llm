// S3 (#60): RFC 4515 / RFC 4514 escaping — LDAP's answer to SQL injection.
//
// PMO ruling 1: filters are built with escaping, never concatenation. A filter
// assembled as `(uid=${input})` lets an input of `alice)(uid=*` close the
// assertion and open another, and the directory answers the WIDER query. That is
// not a theoretical concern: the fixture directory in `__testHelpers__/ldap`
// reproduces it, and `ldapFilterEscape.test.js` proves the two forms differ.
//
// Its own module, because the driver is not the only place a user-supplied value
// reaches a filter — S4's directory sync needs the same rule, and a second
// implementation is how the two drift apart.

/**
 * Escape a value for use inside an LDAP filter assertion (RFC 4515 §3).
 *
 * The backslash goes FIRST and that ordering is load-bearing: escaping `(`
 * before `\` would turn `\(` into `\` + `\28`, and the later backslash pass
 * would then mangle the escape just written. Reordering these lines is a silent
 * correctness bug, not a style change.
 *
 * @param {*} value
 * @returns {string} safe to interpolate between `=` and `)`
 */
function escapeFilterValue(value) {
  // `null` and `undefined` must not become the strings "null"/"undefined" —
  // those are legal filter values and would match a user unlucky enough to be
  // named that, rather than matching nobody.
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/\\/g, "\\5c")
    .replace(/\(/g, "\\28")
    .replace(/\)/g, "\\29")
    .replace(/\*/g, "\\2a")
    .replace(/\0/g, "\\00");
}

/**
 * Escape one DN component's value (RFC 4514 §2.4).
 *
 * A different special set from filters, because a DN is different syntax. This
 * exists for completeness of the seam: the DN a driver binds should come from
 * the SEARCH result, never from user input — but a value that reaches a DN by
 * any path still has to be safe.
 *
 * @param {*} value
 * @returns {string}
 */
function escapeDn(value) {
  if (value === null || value === undefined) return "";
  const text = String(value)
    .replace(/\\/g, "\\\\")
    .replace(/([,+"<>;=])/g, "\\$1")
    // NUL as its hex escape, not a literal: RFC 4514 §2.4 requires it, and a
    // raw NUL truncates the DN at whatever C library eventually parses it —
    // silently binding a shorter, different DN than the one intended.
    .replace(/\0/g, "\\00");
  // A leading `#` or a space at either end is significant in a DN and must be
  // escaped even though the character is otherwise ordinary.
  return text
    .replace(/^ /, "\\ ")
    .replace(/ $/, "\\ ")
    .replace(/^#/, "\\#");
}

module.exports = { escapeFilterValue, escapeDn };
