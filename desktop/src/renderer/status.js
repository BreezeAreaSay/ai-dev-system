// The Status screen: where the system stands and why, every health check with
// its details and what to do about it, and the buttons that do it.
import * as api from "./api.js";
import { DETAIL_ROWS, checkTitle, orderedChecks, recommendation } from "./checks.js";
import { h, progressBar, show } from "./dom.js";

function detailRows(view, details) {
  if (!details || typeof details !== "object") return null;
  const entries = Object.entries(details).filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (!entries.length) return null;
  const rest = entries.length - DETAIL_ROWS;
  return h("dl", { className: "details" },
    entries.slice(0, DETAIL_ROWS).map(([key, value]) => [h("dt", {}, key), h("dd", {}, typeof value === "object" ? JSON.stringify(value) : String(value))]),
    rest > 0 ? [h("dt", {}, "…"), h("dd", {}, view.t("status.moreDetails", { count: rest }))] : null);
}

function checkItem(view, check) {
  const advice = recommendation(view, check);
  const details = detailRows(view, check.details);
  const critical = check.critical === true && check.status === "fail";
  return h("li", { className: `check check-${check.status}`, dataset: { check: check.name, status: check.status, critical: String(check.critical === true) } },
    h("div", { className: "check-head" },
      h("span", { className: "badge" }, view.t(`status.check.${check.status}`)),
      critical ? h("span", { className: "badge badge-critical" }, view.t("status.critical")) : null,
      h("strong", {}, checkTitle(check.name, view.t))),
    h("p", {}, check.summary),
    advice ? h("p", { className: "advice" }, h("span", { className: "label" }, `${view.t("status.recommendation")}: `), advice) : null,
    details ? h("details", {}, h("summary", {}, view.t("status.details")), details) : null);
}

function overview(view, status) {
  const index = status.index.exists
    ? view.t("status.index.documents", { documents: status.index.documents, dense: status.index.dense_documents })
    : view.t("status.index.missing");
  return h("dl", { className: "overview" },
    h("dt", {}, view.t("status.model")), h("dd", { dataset: { field: "model" } }, view.t(status.model.installed ? "status.model.installed" : "status.model.missing")),
    h("dt", {}, view.t("status.index")), h("dd", { dataset: { field: "index" } }, index),
    h("dt", {}, view.t("status.clients")), h("dd", { dataset: { field: "clients" } }, view.t("status.clients.count", status.clients)));
}

/** Why the install is not ok, in the daemon's words, and the settings file's problems (Д-246). */
function why(view, status) {
  if (status.status === "ok") return null;
  return h("div", { className: "why", dataset: { field: "why" } },
    h("p", {}, h("span", { className: "label" }, `${view.t("status.why")}: `), status.summary),
    status.settings_problems?.length
      ? [h("p", { className: "label" }, view.t("status.settingsProblems")), h("ul", { dataset: { field: "settings-problems" } }, status.settings_problems.map((problem) => h("li", {}, problem)))]
      : null);
}

/** The Status screen; it loads the checks when drawn. */
export function statusScreen(view, navigate) {
  const body = h("div", { className: "status-body" }, h("p", { className: "muted", dataset: { state: "loading" } }, view.t("common.working")));
  const refresh = h("button", { type: "button", className: "secondary", dataset: { action: "refresh" } }, view.t("common.refresh"));
  const rebuild = h("button", { type: "button", className: "secondary", dataset: { action: "rebuild" } }, view.t("status.rebuild"));
  const setup = h("button", { type: "button", className: "secondary", dataset: { action: "setup" }, on: { click: () => navigate("wizard") } }, view.t("status.runSetup"));
  const work = h("div", { className: "work" });

  const load = () => api.call("system_status", { checks: true }).then((status) => {
    show(body,
      h("p", { className: `overall overall-${status.status}`, dataset: { field: "overall", status: status.status } }, view.t(`status.overall.${status.status}`)),
      why(view, status),
      h("p", { className: "muted" }, view.t("status.version", { version: status.version, pid: status.served_by.pid, sessions: status.served_by.sessions ?? 0 })),
      overview(view, status),
      h("h2", {}, view.t("status.checks")),
      h("ul", { className: "checks" }, orderedChecks(status.checks).map((check) => checkItem(view, check))));
  }, (error) => show(body, h("p", { className: "error", role: "alert" }, view.t("common.error", { message: error.message }))));

  refresh.addEventListener("click", load);
  rebuild.addEventListener("click", () => {
    const bar = progressBar();
    rebuild.disabled = true;
    show(work, bar.element);
    api.call("rebuild_search_index", {}, { onProgress: (event) => bar.update(event) })
      .then(() => show(work), (error) => show(work, h("p", { className: "error" }, view.t("common.error", { message: error.message }))))
      .finally(() => {
        rebuild.disabled = false;
        load();
      });
  });
  load();
  return h("section", { dataset: { screen: "status" } },
    h("h1", { tabindex: "-1" }, view.t("status.title")),
    h("div", { className: "actions" }, refresh, rebuild, setup),
    work,
    body);
}
