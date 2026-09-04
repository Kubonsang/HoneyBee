import type { DesktopProjectV2 } from "../shared/ipc.js";

export const selectInitialProject = (
  projects: readonly DesktopProjectV2[],
  recentProjectId: string | null,
): DesktopProjectV2 | undefined =>
  projects.find((item) => item.projectId === recentProjectId) ?? projects[0];
