/** AppErrorCode → Fluent 文案 ID。请求失败与历史回放共用。 */

import type { FluentMessageId } from "../../typings/i10n";
import type { AppErrorCode } from "../utils/errors";

export const ERROR_MESSAGE_IDS: Partial<Record<AppErrorCode, FluentMessageId>> =
  {
    CONFIG_MISSING: "error-config-missing",
    INVALID_CONFIG: "error-invalid-config",
    AUTH: "error-auth",
    RATE_LIMIT: "error-rate-limit",
    BAD_REQUEST: "error-bad-request",
    SERVER: "error-server",
    NETWORK: "error-network",
    TIMEOUT_START: "error-timeout",
    TIMEOUT_IDLE: "error-timeout",
    TIMEOUT_TOTAL: "error-timeout",
    PROVIDER_ERROR: "error-provider",
    DB_ERROR: "error-db",
    NO_FULLTEXT: "error-no-fulltext",
  };

export function errorMessageID(
  code: string | undefined,
): FluentMessageId | undefined {
  if (!code) {
    return undefined;
  }
  return ERROR_MESSAGE_IDS[code as AppErrorCode];
}
