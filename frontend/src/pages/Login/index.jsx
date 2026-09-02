import React from "react";
import PasswordModal, { usePasswordModal } from "@/components/Modals/Password";
import { FullScreenLoader } from "@/components/Preloader";
import { Navigate } from "react-router-dom";
import paths from "@/utils/paths";
import useQuery from "@/hooks/useQuery";
import useSimpleSSO from "@/hooks/useSimpleSSO";

/**
 * Login page that handles both single and multi-user login.
 *
 * @returns {JSX.Element}
 */
export default function Login() {
  const query = useQuery();
  const { loading: ssoLoading, ssoConfig } = useSimpleSSO();
  const { loading, requiresAuth, mode } = usePasswordModal(!!query.get("nt"));

  if (loading || ssoLoading) return <FullScreenLoader />;

  // #50: SIMPLE_SSO_NO_LOGIN still disables credential login and the server
  // still enforces it. What changed is the destination: /sso/simple is deleted,
  // so a forced user goes to a real IdP login instead.
  if (ssoConfig.enabled && ssoConfig.noLogin) {
    // An explicit redirect URL is the operator's own choice and wins.
    if (!!ssoConfig.noLoginRedirect && !query.has("token"))
      return window.location.replace(ssoConfig.noLoginRedirect);

    // Otherwise start a login with the first enabled provider. Not a <Navigate>:
    // this is a server route that redirects to the IdP, not a client one.
    const [provider] = ssoConfig.providers ?? [];
    if (provider) {
      window.location.replace(paths.sso.login(provider));
      return <FullScreenLoader />;
    }

    // Credential login disabled with no provider configured and no redirect set
    // is a locked-out instance. Say so, rather than navigating somewhere that
    // renders a blank screen.
    return (
      <div className="w-screen h-screen overflow-hidden bg-theme-bg-primary flex items-center justify-center flex-col gap-4">
        <p className="text-theme-text-primary font-mono text-lg">
          Login via credentials has been disabled by the administrator.
        </p>
        <p className="text-theme-text-secondary font-mono text-sm">
          No identity provider is enabled, so there is no way to sign in. The
          system administrator must enable one or unset SIMPLE_SSO_NO_LOGIN.
        </p>
      </div>
    );
  }

  if (requiresAuth === false) return <Navigate to={paths.home()} />;

  return <PasswordModal mode={mode} />;
}
