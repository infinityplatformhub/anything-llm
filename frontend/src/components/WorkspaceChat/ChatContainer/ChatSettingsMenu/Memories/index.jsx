import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import useUser from "@/hooks/useUser";
import useCapabilities from "@/hooks/useCapabilities";
import System from "@/models/system";
import { useMemoriesSidebar, useSourcesSidebar } from "../../ChatSidebar";

export default function MemoriesRow({ onClose }) {
  const { t } = useTranslation();
  const { user } = useUser();
  const { toggleSidebar } = useMemoriesSidebar();
  const { closeSidebar } = useSourcesSidebar();
  const [memoryEnabled, setMemoryEnabled] = useState(null);

  // #40 task 4. Same capability as MemoriesContext deliberately — this row opens the sidebar
  // that MemoriesContext gates, and the two must agree. If this row used a different question
  // the entry point and the panel behind it could disagree, giving a caller a menu item that
  // opens an empty sidebar.
  //
  // `settings.write`, not `workspace.write`: memory is an instance preference
  // (`Admin.updateSystemPreferences`, gated `settings.write` at `endpoints/admin.js:546,672`).
  const { can, loading: capabilitiesLoading } = useCapabilities();
  const canManageMemory =
    !user || (!capabilitiesLoading && can("settings.write"));

  useEffect(() => {
    System.keys().then((settings) => {
      setMemoryEnabled(!!settings?.MemoryEnabled);
    });
  }, []);

  function handleClick() {
    closeSidebar();
    toggleSidebar();
    onClose();
  }

  if (memoryEnabled === null) return null;
  if (!canManageMemory && !memoryEnabled) return null;

  return (
    <div
      onClick={handleClick}
      className="flex items-center px-2 py-1 rounded cursor-pointer hover:bg-zinc-700 light:hover:bg-slate-200"
    >
      <span className="text-sm font-normal text-white light:text-slate-800">
        {t("chat_window.memories.title")}
      </span>
    </div>
  );
}
