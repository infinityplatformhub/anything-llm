import { useEffect, useState } from "react";
import System from "@/models/system";

/**
 * Checks if Simple SSO is enabled and if the user should be redirected to the SSO login page.
 * @returns {{loading: boolean, ssoConfig: {enabled: boolean, noLogin: boolean, noLoginRedirect: string | null, providers: string[]}}}
 */
export default function useSimpleSSO() {
  const [loading, setLoading] = useState(true);
  const [ssoConfig, setSsoConfig] = useState({
    enabled: false,
    noLogin: false,
    noLoginRedirect: null,
    // #50: where to send a user the login screen refuses to serve.
    providers: [],
  });

  useEffect(() => {
    async function checkSsoConfig() {
      try {
        const settings = await System.keys();
        setSsoConfig({
          enabled: settings?.SimpleSSOEnabled,
          noLogin: settings?.SimpleSSONoLogin,
          noLoginRedirect: settings?.SimpleSSONoLoginRedirect,
          providers: settings?.SSOProviders ?? [],
        });
      } catch (e) {
        console.error(e);
      } finally {
        setLoading(false);
      }
    }
    checkSsoConfig();
  }, []);

  return { loading, ssoConfig };
}
