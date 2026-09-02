import React, { useState, createContext, useEffect } from "react";
import {
  AUTH_TIMESTAMP,
  AUTH_TOKEN,
  AUTH_USER,
  USER_PROMPT_INPUT_MAP,
} from "@/utils/constants";
import System from "./models/system";
import { useNavigate } from "react-router-dom";
import { safeJsonParse } from "@/utils/request";
import { resetCapabilities } from "@/hooks/useCapabilities";

export const AuthContext = createContext(null);
export function AuthProvider(props) {
  const localUser = localStorage.getItem(AUTH_USER);
  const localAuthToken = localStorage.getItem(AUTH_TOKEN);
  const [store, setStore] = useState({
    user: localUser ? safeJsonParse(localUser, null) : null,
    authToken: localAuthToken ? localAuthToken : null,
  });

  const navigate = useNavigate();

  /* NOTE:
   * 1. There's no reason for these helper functions to be stateful. They could
   * just be regular funcs or methods on a basic object.
   * 2. These actions are not being invoked anywhere in the
   * codebase, dead code.
   */
  const [actions] = useState({
    updateUser: (user, authToken = "") => {
      localStorage.setItem(AUTH_USER, JSON.stringify(user));
      localStorage.setItem(AUTH_TOKEN, authToken);
      setStore({ user, authToken });
    },
    unsetUser: () => {
      // #40 task 3: the capability map is cached per session, not per user. A
      // second login in the same tab would otherwise read the previous user's
      // answers and gate the UI on their grants.
      resetCapabilities();
      localStorage.removeItem(AUTH_USER);
      localStorage.removeItem(AUTH_TOKEN);
      localStorage.removeItem(AUTH_TIMESTAMP);
      localStorage.removeItem(USER_PROMPT_INPUT_MAP);
      setStore({ user: null, authToken: null });
    },
  });

  /*
   * On initial mount and whenever the token changes, fetch a new user object
   * If the user is suspended, (success === false and data === null) logout the user and redirect to the login page
   * If success is true and data is not null, update the user object in the store (multi-user mode only)
   * If success is true and data is null, do nothing (single-user mode only) with or without password protection
   */
  useEffect(() => {
    async function refreshUser() {
      const { success, user: refreshedUser } = await System.refreshUser();
      if (success && refreshedUser === null) return;

      if (!success) {
        // Same reason as unsetUser: this branch is a logout too.
        resetCapabilities();
        localStorage.removeItem(AUTH_USER);
        localStorage.removeItem(AUTH_TOKEN);
        localStorage.removeItem(AUTH_TIMESTAMP);
        localStorage.removeItem(USER_PROMPT_INPUT_MAP);
        setStore({ user: null, authToken: null });
        navigate("/login");
        return;
      }

      localStorage.setItem(AUTH_USER, JSON.stringify(refreshedUser));
      setStore((prev) => ({
        ...prev,
        user: refreshedUser,
      }));
    }
    if (store.authToken) refreshUser();
  }, [store.authToken]);

  return (
    <AuthContext.Provider value={{ store, actions }}>
      {props.children}
    </AuthContext.Provider>
  );
}
