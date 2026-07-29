import type { Result } from "@honeybee/domain";

/** Stable failure categories exposed by storage adapters. */
export type StorageDriverErrorCode =
  | "cancelled"
  | "destination-conflict"
  | "invalid-source"
  | "io"
  | "protocol"
  | "unsupported"
  | "verification-failed";

/** A technology-neutral storage failure returned across the port boundary. */
export interface StorageDriverError {
  readonly code: StorageDriverErrorCode;
  readonly message: string;
}

/** Paths used when probing whether a driver can prepare an isolated copy. */
export interface StorageCapabilityRequest {
  readonly sourcePath: string;
  readonly destinationPath: string;
}

/**
 * Technology-neutral capabilities observed for one source/destination pair.
 *
 * Capabilities are scoped to the probe request because volume, filesystem, and
 * helper availability can differ between operations.
 */
export interface StorageDriverCapability {
  readonly driverId: string;
  readonly available: boolean;
  readonly supportsCopyOnWrite: boolean;
  readonly supportsIncrementalPreparation: boolean;
  readonly supportsProgress: boolean;
  readonly supportsCancellation: boolean;
  readonly reportsPhysicalBytes: boolean;
  readonly unavailableReason?: string;
}

/** Progress data that is independent of any UI event protocol. */
export interface StorageProgress {
  readonly phase: "cleanup" | "prepare" | "verify";
  readonly completedBytes: number;
  readonly completedFiles: number;
  readonly totalBytes?: number;
  readonly totalFiles?: number;
}

/** Cross-operation cancellation and progress hooks. */
export interface StorageOperationOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: StorageProgress) => void;
}

/** Request to prepare a writable destination from an immutable source. */
export interface StoragePrepareRequest extends StorageOperationOptions {
  readonly sourcePath: string;
  readonly destinationPath: string;
}

/** Request to independently revalidate a prepared destination. */
export interface StorageVerifyRequest extends StorageOperationOptions {
  readonly sourcePath: string;
  readonly destinationPath: string;
}

/** Request to remove an incomplete or no-longer-needed destination. */
export interface StorageCleanupRequest extends StorageOperationOptions {
  readonly destinationPath: string;
}

/** Technology-neutral measurements and issues produced by verification. */
export interface StorageVerification {
  readonly valid: boolean;
  readonly logicalBytes: number;
  readonly physicalBytes?: number;
  readonly fileCount: number;
  readonly contentHash?: string;
  readonly issues: readonly string[];
}

/**
 * A completed preparation, including the verification needed before a
 * workspace can be promoted to a ready state.
 */
export interface StoragePreparation {
  readonly driverId: string;
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly logicalBytes: number;
  readonly physicalBytes?: number;
  readonly fileCount: number;
  readonly verification: StorageVerification;
}

/**
 * Result-focused boundary for preparing an isolated, writable Library.
 *
 * A safe PhysicalCopy adapter, an opt-in ReFS block-clone adapter, and an
 * optional versioned Rust-helper adapter must all implement this same port.
 * Callers select an adapter from `capability`, require a successful `verify`,
 * and may fall back to PhysicalCopy when an optimized adapter is unavailable
 * or fails. The interface promises isolation and verification, never a
 * particular filesystem mechanism.
 *
 * Implementations own incomplete markers and must make `cleanup` safe to
 * retry. They may report progress and observe cancellation through the
 * operation options, but must not depend on a UI-specific event shape.
 */
export interface StorageDriver {
  capability(
    request: StorageCapabilityRequest,
  ): Promise<Result<StorageDriverCapability, StorageDriverError>>;
  prepare(request: StoragePrepareRequest): Promise<Result<StoragePreparation, StorageDriverError>>;
  verify(request: StorageVerifyRequest): Promise<Result<StorageVerification, StorageDriverError>>;
  cleanup(request: StorageCleanupRequest): Promise<Result<void, StorageDriverError>>;
}
