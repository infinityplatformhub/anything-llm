function requireScope(scope) {
  return function scopeRequired(_request, response, next) {
    const scopes = response.locals.actor?.scopes || [];
    if (!scopes.includes("*") && !scopes.includes(scope)) return response.status(403).json({ error: "API key lacks required scope." });
    next();
  };
}

module.exports = { requireScope };
