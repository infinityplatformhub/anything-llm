import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { isMobile } from "react-device-detect";
import useUser from "@/hooks/useUser";
import { useWorkspaceCapabilities } from "@/hooks/useCapabilities";
import { useModal } from "@/hooks/useModal";
import LLMSelectorModal from "../PromptInput/LLMSelector/index";
import SetupProvider from "../PromptInput/LLMSelector/SetupProvider";
import {
  SAVE_LLM_SELECTOR_EVENT,
  PROVIDER_SETUP_EVENT,
} from "../PromptInput/LLMSelector/action";
import Workspace from "@/models/workspace";
import System from "@/models/system";
import ModelRouterAPI from "@/models/modelRouter";
import { SIDEBAR_TOGGLE_EVENT } from "@/components/Sidebar/SidebarToggle";

async function resolveModelName(workspace, systemSettings, t) {
  const effectiveProvider =
    workspace.chatProvider ?? systemSettings?.LLMProvider;

  if (effectiveProvider !== "anythingllm-router")
    return workspace.chatModel ?? systemSettings?.LLMModel ?? "";

  const routerId = workspace.router_id || systemSettings?.ModelRouterId;
  if (!routerId) return t("model-router.metrics.model-router-default");

  const { router } = await ModelRouterAPI.get(routerId);
  if (!router?.name) return t("model-router.metrics.model-router-default");

  return router.name;
}

async function fetchModelName(slug, setModelName, t) {
  if (!slug) return;
  const [workspace, systemSettings] = await Promise.all([
    Workspace.bySlug(slug),
    System.keys(),
  ]);
  setModelName(await resolveModelName(workspace, systemSettings, t));
}

export default function WorkspaceModelPicker({
  workspaceSlug = null,
  workspaceId = null,
}) {
  const { t } = useTranslation();
  const { slug: urlSlug } = useParams();
  const slug = urlSlug ?? workspaceSlug;
  const { user } = useUser();
  const { can, visible, loading } = useWorkspaceCapabilities(workspaceId);
  const [showSelector, setShowSelector] = useState(false);
  const [modelName, setModelName] = useState("");
  const {
    isOpen: isSetupProviderOpen,
    openModal: openSetupProviderModal,
    closeModal: closeSetupProviderModal,
  } = useModal();
  const [config, setConfig] = useState({ settings: {}, provider: null });
  const [refreshKey, setRefreshKey] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(
    () =>
      window.localStorage.getItem("approofworkspace_sidebar_toggle") !==
      "closed"
  );

  useEffect(() => {
    const handleToggle = (e) => setSidebarOpen(e.detail.open);
    window.addEventListener(SIDEBAR_TOGGLE_EVENT, handleToggle);
    return () => window.removeEventListener(SIDEBAR_TOGGLE_EVENT, handleToggle);
  }, []);

  // Fetch current model name for display
  useEffect(() => {
    fetchModelName(slug, setModelName, t);
  }, [slug]);

  // Close selector and refresh model name when model is saved
  useEffect(() => {
    function handleSave() {
      setShowSelector(false);
      fetchModelName(slug, setModelName, t);
    }
    window.addEventListener(SAVE_LLM_SELECTOR_EVENT, handleSave);
    return () =>
      window.removeEventListener(SAVE_LLM_SELECTOR_EVENT, handleSave);
  }, [slug]);

  // Handle provider setup request
  useEffect(() => {
    function handleProviderSetup(e) {
      const { provider, settings } = e.detail;
      setConfig({ settings, provider });
      setTimeout(() => openSetupProviderModal(), 300);
    }
    window.addEventListener(PROVIDER_SETUP_EVENT, handleProviderSetup);
    return () =>
      window.removeEventListener(PROVIDER_SETUP_EVENT, handleProviderSetup);
  }, []);

  // #40 task 4: the engine decides, not the role string.
  //
  // `workspace.write`, not the org-level `settings.write`: this picks the model FOR THIS
  // WORKSPACE, and an org capability would stop a workspace owner from configuring their own
  // workspace without an instance-wide permission.
  //
  // `visible` is checked separately from `can`: false means the caller cannot see this
  // workspace at all, which the server answers identically for "absent" and "not yours". A
  // `can()`-only check would also be false there, so it would pass while proving nothing.
  // `loading` is checked and is REDUNDANT today — mutation removed it and the suite stayed
  // green. While the fetch is in flight `state.workspace` is null, so `visible` is already
  // false and the gate is closed by that alone. It is kept because the two answers are
  // independent in principle (a future hook could keep a stale workspace while refetching, and
  // then `visible` would be true mid-flight), and because a reader who sees only `visible`
  // here would reasonably conclude the loading case was never considered. Documented as
  // redundant rather than defended with a contrived test.
  //
  // The `!user` branch stays: it is single-user mode, where nothing is gated and the operator
  // would otherwise watch this disappear on every first paint.
  if (!!user && !(!loading && visible && can("workspace.write"))) return null;
  if (!slug || isMobile) return null;

  return (
    <>
      {showSelector && (
        <div
          className="fixed inset-0 z-20"
          onClick={() => setShowSelector(false)}
        />
      )}
      <div
        className={`hidden md:block absolute top-2 z-30 transition-all duration-500 ${
          sidebarOpen ? "left-3" : "left-11"
        }`}
      >
        <button
          type="button"
          onClick={() => setShowSelector(!showSelector)}
          className={`group border-none cursor-pointer px-2.5 py-1 flex items-center rounded-full transition-all ${
            showSelector
              ? "bg-zinc-700 light:bg-slate-200"
              : "hover:bg-zinc-700 light:hover:bg-slate-200"
          }`}
        >
          <span
            className={`text-xs ${
              showSelector
                ? "text-white light:text-slate-800"
                : "text-zinc-500 light:text-slate-500 group-hover:text-white light:group-hover:text-slate-800"
            }`}
          >
            {modelName || t("chat_window.select_model")}
          </span>
        </button>

        {showSelector && (
          <div className="absolute left-0 top-full mt-1 bg-zinc-800 light:bg-white border border-zinc-700 light:border-slate-300 rounded-xl shadow-lg w-[620px] overflow-hidden">
            <LLMSelectorModal
              key={refreshKey}
              workspaceSlug={slug}
              initialProvider={config.provider?.value}
            />
          </div>
        )}
      </div>

      <SetupProvider
        isOpen={isSetupProviderOpen}
        closeModal={closeSetupProviderModal}
        postSubmit={() => {
          closeSetupProviderModal();
          setRefreshKey((k) => k + 1);
        }}
        settings={config.settings}
        llmProvider={config.provider}
      />
    </>
  );
}
