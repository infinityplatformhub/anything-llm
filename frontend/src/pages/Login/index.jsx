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

  // #50: SIMPLE_SSO_NO_LOGIN still disables credential login — the server
  // enforces it (endpoints/invite.js, endpoints/admin.js, /request-token) and
  // that protection is deliberately kept. What is gone is the passthrough page
  // it used to redirect to, so there is no longer anywhere to send the user
  // except the operator's own URL.
  if (ssoConfig.enabled && ssoConfig.noLogin) {
    if (!!ssoConfig.noLoginRedirect && !query.has("token"))
      return window.location.replace(ssoConfig.noLoginRedirect);
    // No redirect configured: say so plainly. Navigating to a deleted route
    // rendered a blank "No token provided." screen with no way forward.
    return (
      <div className="w-screen h-screen overflow-hidden bg-theme-bg-primary flex items-center justify-center flex-col gap-4">
        <p className="text-theme-text-primary font-mono text-lg">
          Login via credentials has been disabled by the administrator.
        </p>
        <p className="text-theme-text-secondary font-mono text-sm">
          Sign in through your identity provider, or contact the system
          administrator.
        </p>
      </div>
    );
  }

  if (requiresAuth === false) return <Navigate to={paths.home()} />;

  return <PasswordModal mode={mode} />;
}
