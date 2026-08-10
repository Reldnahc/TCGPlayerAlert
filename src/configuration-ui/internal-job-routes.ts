import type {
  ConfigurationRouteContext,
  ConfigurationRouteHandler,
} from "./context.js";
import { readJsonBody, sendJson } from "./http.js";

export const handleInternalJobRoute: ConfigurationRouteHandler = async (
  context,
) => {
  const { request, response, url, internalJobRunnerRunning } = context;
  if (url.pathname === "/api/internal-jobs") {
    if (request.method !== "GET") return false;
    if (!requireInternalJobs(context)) return true;
    sendJson(response, 200, {
      ...(await context.internalJobs.snapshot()),
      runnerRunning: internalJobRunnerRunning,
    });
    return true;
  }
  if (url.pathname === "/api/internal-jobs/listings") {
    if (request.method !== "POST") return false;
    if (!requireInternalJobs(context)) return true;
    sendJson(response, 202, {
      schedule: await context.internalJobs.addScheduledListing(
        await readJsonBody(request),
      ),
    });
    return true;
  }
  if (url.pathname === "/api/internal-jobs/schedules") {
    if (request.method !== "POST") return false;
    if (!requireInternalJobs(context)) return true;
    sendJson(response, 201, {
      schedule: await context.internalJobs.createSchedule(
        await readJsonBody(request),
      ),
    });
    return true;
  }
  const runMatch = /^\/api\/internal-jobs\/runs\/([0-9a-f-]{36})$/iu.exec(
    url.pathname,
  );
  if (runMatch !== null) {
    if (request.method !== "DELETE") return false;
    if (!requireInternalJobs(context)) return true;
    sendJson(response, 200, {
      run: await context.internalJobs.cancelRun(runMatch[1] ?? ""),
    });
    return true;
  }
  const scheduleMatch =
    /^\/api\/internal-jobs\/schedules\/([0-9a-f-]{36})(\/run)?$/iu.exec(
      url.pathname,
    );
  if (scheduleMatch === null) return false;
  if (!requireInternalJobs(context)) return true;
  const scheduleId = scheduleMatch[1] ?? "";
  if (scheduleMatch[2] === "/run") {
    if (request.method !== "POST") return false;
    await readJsonBody(request);
    sendJson(response, 202, {
      run: await context.internalJobs.requestRun(scheduleId),
    });
    return true;
  }
  if (request.method === "PUT") {
    sendJson(response, 200, {
      schedule: await context.internalJobs.updateSchedule(
        scheduleId,
        await readJsonBody(request),
      ),
    });
    return true;
  }
  if (request.method === "DELETE") {
    await context.internalJobs.deleteSchedule(scheduleId);
    sendJson(response, 200, { deleted: true });
    return true;
  }
  return false;
};

function requireInternalJobs(
  context: ConfigurationRouteContext,
): context is ConfigurationRouteContext & {
  readonly internalJobs: NonNullable<ConfigurationRouteContext["internalJobs"]>;
} {
  if (context.internalJobs !== undefined) return true;
  sendJson(context.response, 503, {
    message: "Internal job scheduling is unavailable.",
  });
  return false;
}
