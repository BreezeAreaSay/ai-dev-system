// The Status screen: where the system stands, every health check with its
// details and what to do about it, and the buttons that do it.
import * as api from "./api.js";
import { h, progressBar, show } from "./dom.js";

const CHECK_WORDS = Object.freeze({ ui: "UI", ux: "UX", qa: "QA", fts: "FTS", mcp: "MCP" });

/** `frontend_qa_runner` → `Frontend QA runner`, as the dashboard writes it. */
export function checkTitle(name) {
  const title = String(name).split("_").filter(Boolean).map((word) => CHECK_WORDS[word] ?? word).join(" ");
  return title.charAt(0).toUpperCase() + title.slice(1);
}

/** What to do about a check that is not ok, in the page's language. */
export function recommendation(view, check) {
  if (check.status === "ok") return null;
  const specific = `recommend.${check.name}`;
  const text = view.t(specific);
  if (text !== specific) return text;
  return view.t(check.status === "fail" ? "recommend.default.fail" : "recommend.default.warn");
}

function detailRows(details) {
  if (!details || typeof details !== "object") return null;
  const entries = Object.entries(details).filter(([, value]) => value !== undefined && value !== null && value !== "");
  if (!entries.length) return null;
  return h("dl", { className: "details" }, entries.slice(0, 20).map(([key, value]) => [
    h("dt", {}, key),
    h("dd", {}, typeof value === "object" ? JSON.stringify(value) : String(value))
  ]));
}

function checkItem(view, check) {
  const advice = recommendation(view, check);
  const details = detailRows(check.details);
  return h("li", { className: `check check-${check.status}`, dataset: { check: check.name, status: check.status } },
    h("div", { className: "check-head" },
      h("span", { className: "badge" }, view.t(`status.check.${check.status}`)),
      h("strong", {}, checkTitle(check.name))),
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

/** The Status screen; it loads the checks when drawn. */
export function statusScreen(view, navigate) {
  const body = h("div", { className: "status-body" }, h("p", { className: "muted" }, view.t("common.working")));
  const refresh = h("button", { type: "button", className: "secondary", dataset: { action: "refresh" } }, view.t("common.refresh"));
  const rebuild = h("button", { type: "button", className: "secondary", dataset: { action: "rebuild" } }, view.t("status.rebuild"));
  const setup = h("button", { type: "button", className: "secondary", dataset: { action: "setup" }, on: { click: () => navigate("wizard") } }, view.t("status.runSetup"));
  const work = h("div", { className: "work" });

  const load = () => api.call("system_status", { checks: true }).then((status) => {
    show(body,
      h("p", { className: `overall overall-${status.status}`, dataset: { field: "overall", status: status.status } }, view.t(`status.overall.${status.status}`)),
      h("p", { className: "muted" }, view.t("status.version", { version: status.version, pid: status.served_by.pid, sessions: status.served_by.sessions ?? 0 })),
      overview(view, status),
      h("h2", {}, view.t("status.checks")),
      h("ul", { className: "checks" }, status.checks.map((check) => checkItem(view, check))));
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
