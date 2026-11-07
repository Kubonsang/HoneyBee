import type {
  DesktopRecoveryActionV2,
  DesktopRecoveryOperationV2,
} from "../../apps/desktop/src/shared/ipc.js";
export class SetupRecoveryController {
  constructor(options: {
    enabled(): boolean;
    root(): string;
    applicationBusy(): boolean;
    trust: {
      schemaVersion: number;
      bootstrapperVersion: string;
      channel: string;
      publicKeys: readonly string[];
    };
  });
  isBusy(): boolean;
  status(): Promise<DesktopRecoveryOperationV2>;
  action(request: DesktopRecoveryActionV2): Promise<DesktopRecoveryOperationV2>;
}
