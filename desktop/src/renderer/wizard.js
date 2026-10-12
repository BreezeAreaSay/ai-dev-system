// The first-run wizard: projects folder, AI clients, local model, search
// index, and what next. Each step calls the control API and shows what came
// back; a long step shows its progress and can be cancelled.
import * as api from "./api.js";
import { formatBytes, h, progressBar, show } from "./dom.js";

const STEPS = ["projects", "clients", "model", "index", "done"];

const wizard = { step: 0 };

/** One running call: its id for Cancel, and the cancel button's state. */
function running(view, body, { label, tool, args, onDone, onFail }) {
  const bar = progressBar();
  bar.update({ message: label });
  let id = null;
  const cancelButton = h("button", {
    type: "button",
    className: "secondary",
    dataset: { action: "cancel" },
    on: { click: () => id && api.cancel(id) }
  }, view.t("common.cancel"));
  show(body, bar.element, cancelButton);
  api.call(tool, args, {
    onStart: (started) => { id = started; },
    onProgress: (event) => bar.update({ ...event, message: event.message || label })
  }).then(onDone, onFail);
}

function errorLine(view, error) {
  return h("p", { className: error.cancelled ? "notice" : "error", role: "alert" },
    error.cancelled ? view.t("common.cancelled") : view.t("common.error", { message: error.message }));
}

function projectsStep(view, body, footer) {
  const line = h("p", { className: "muted", dataset: { field: "projects-root" } }, view.t("wizard.projects.none"));
  const choose = h("button", {
    type: "button",
    className: "primary",
    dataset: { action: "choose-projects" },
    on: {
      async click() {
        const folder = await api.chooseFolder("projects");
        if (!folder) return;
        try {
          await api.call("settings_set", { settings: { projects_root: folder } });
          line.textContent = view.t("wizard.projects.chosen", { path: folder });
          line.className = "";
        } catch (error) {
          line.replaceWith(errorLine(view, error));
        }
      }
    }
  }, view.t("wizard.projects.choose"));
  show(body, h("p", {}, view.t("wizard.projects.body")), choose, line);
  api.call("settings_get").then((answer) => {
    if (answer.settings?.projects_root) {
      line.textContent = view.t("wizard.projects.chosen", { path: answer.settings.projects_root });
      line.className = "";
    }
  }, () => undefined);
  footer.next.disabled = false;
}

function clientsStep(view, body, footer) {
  show(body, h("p", {}, view.t("wizard.clients.body")), h("p", { className: "muted" }, view.t("common.working")));
  footer.next.disabled = false;
  api.call("clients_list").then((answer) => {
    const boxes = [];
    const rows = answer.clients.map((client) => {
      const box = h("input", {
        type: "checkbox",
        name: "client",
        value: client.client,
        checked: client.found && !client.connected,
        disabled: !client.found
      });
      boxes.push(box);
      const note = !client.found ? view.t("wizard.clients.notFound")
        : client.connected ? view.t("wizard.clients.connected") : view.t("wizard.clients.found");
      return h("li", { dataset: { client: client.client } }, h("label", {}, box, " ", client.label, " ", h("span", { className: "muted" }, `— ${note}`)));
    });
    const result = h("p", { className: "muted", dataset: { field: "clients-result" } });
    const connect = h("button", {
      type: "button",
      className: "primary",
      dataset: { action: "connect-clients" },
      on: {
        async click() {
          const chosen = boxes.filter((box) => box.checked && !box.disabled).map((box) => box.value);
          if (!chosen.length) return;
          connect.disabled = true;
          try {
            const outcome = await api.call("clients_install", { clients: chosen });
            result.textContent = view.t("wizard.clients.result", { changed: outcome.changed, failed: outcome.failed });
          } catch (error) {
            result.replaceWith(errorLine(view, error));
          } finally {
            connect.disabled = false;
          }
        }
      }
    }, view.t("wizard.clients.connect"));
    const found = answer.clients.some((client) => client.found);
    show(body, h("p", {}, view.t("wizard.clients.body")),
      found ? [h("ul", { className: "choices" }, rows), connect, result] : h("p", {}, view.t("wizard.clients.none")));
  }, (error) => show(body, errorLine(view, error)));
}

function modelStep(view, body, footer) {
  const draw = (note) => {
    show(body, h("p", {}, view.t("wizard.model.body")), h("p", { className: "muted" }, view.t("common.working")));
    api.call("system_status", { checks: false }).then((status) => {
      const model = status.model;
      wizard.modelInstalled = Boolean(model.installed);
      // Without the model the way on is to skip it: search works by words.
      footer.next.textContent = view.t(model.installed ? "common.next" : "wizard.model.skip");
      if (model.installed) {
        show(body, h("p", {}, view.t("wizard.model.body")), h("p", { className: "ok", dataset: { field: "model-state" } }, view.t("wizard.model.installed")), note);
        return;
      }
      const partial = (model.partial ?? []).reduce((sum, file) => sum + (file.bytes ?? 0), 0);
      const done = (answer) => draw(answer?.ready ? null : h("p", { className: "error" }, view.t("common.error", { message: (answer?.mismatched ?? []).join(", ") || "not ready" })));
      const failed = (error) => draw(errorLine(view, error));
      const download = h("button", {
        type: "button",
        className: "primary",
        dataset: { action: "download-model" },
        on: { click: () => running(view, body, { label: view.t("wizard.model.downloading"), tool: "model_install", args: {}, onDone: done, onFail: failed }) }
      }, view.t("wizard.model.download"));
      const importButton = h("button", {
        type: "button",
        className: "secondary",
        dataset: { action: "import-model" },
        on: {
          async click() {
            const source = await api.chooseFolder("model");
            if (!source) return;
            running(view, body, { label: view.t("wizard.model.importing"), tool: "model_import", args: { source }, onDone: done, onFail: failed });
          }
        }
      }, view.t("wizard.model.import"));
      show(body,
        h("p", {}, view.t("wizard.model.body")),
        h("div", { className: "actions" }, download, importButton),
        partial ? h("p", { className: "muted", dataset: { field: "model-partial" } }, view.t("wizard.model.partial", { bytes: formatBytes(partial, view.language) })) : null,
        note);
    }, (error) => show(body, errorLine(view, error)));
  };
  footer.next.disabled = false;
  footer.next.textContent = view.t("common.next");
  draw(null);
}

function indexStep(view, body, footer) {
  footer.next.disabled = true;
  const start = h("button", {
    type: "button",
    className: "primary",
    dataset: { action: "build-index" },
    on: {
      click: () => running(view, body, {
        label: view.t("wizard.index.running"),
        tool: "setup_run",
        args: wizard.modelInstalled ? { model: true } : {},
        onDone(answer) {
          const count = (status) => answer.steps.filter((step) => step.status === status).length;
          const list = h("ul", { className: "steps" }, answer.steps.map((step) => h("li", { dataset: { step: step.id, status: step.status } },
            h("strong", {}, step.title), ` — ${step.status}`, step.reason ? h("span", { className: "muted" }, ` (${step.reason})`) : null)));
          show(body, h("p", { dataset: { field: "index-result" } }, view.t("wizard.index.result", { done: count("done"), skipped: count("skipped"), failed: count("failed") })), list);
          footer.next.disabled = false;
        },
        onFail(error) {
          show(body, errorLine(view, error), start);
          footer.next.disabled = false;
        }
      })
    }
  }, view.t("wizard.index.start"));
  show(body, h("p", {}, view.t("wizard.index.body")), start);
}

function doneStep(view, body, footer, navigate) {
  footer.next.hidden = true;
  show(body,
    h("p", {}, view.t("wizard.done.body")),
    h("ol", {}, h("li", {}, view.t("wizard.done.next1")), h("li", {}, view.t("wizard.done.next2")), h("li", {}, view.t("wizard.done.next3"))),
    h("button", { type: "button", className: "primary", dataset: { action: "open-status" }, on: { click: () => { wizard.step = 0; navigate("status"); } } }, view.t("wizard.done.status")));
}

const DRAW = { projects: projectsStep, clients: clientsStep, model: modelStep, index: indexStep, done: doneStep };

/** The wizard at its current step. */
export function wizardScreen(view, navigate) {
  const name = STEPS[wizard.step];
  const body = h("div", { className: "step-body" });
  const back = h("button", { type: "button", className: "secondary", dataset: { action: "back" }, disabled: wizard.step === 0 }, view.t("common.back"));
  const next = h("button", { type: "button", className: "primary", dataset: { action: "next" } }, view.t("common.next"));
  const section = h("section", { className: "wizard", dataset: { screen: "wizard", step: name } },
    h("p", { className: "muted" }, view.t("wizard.step", { step: wizard.step + 1, total: STEPS.length })),
    h("h1", { tabindex: "-1" }, view.t(`wizard.${name}.title`)),
    body,
    h("footer", { className: "wizard-footer" }, back, next));
  back.addEventListener("click", () => {
    wizard.step = Math.max(0, wizard.step - 1);
    navigate("wizard");
  });
  next.addEventListener("click", () => {
    wizard.step = Math.min(STEPS.length - 1, wizard.step + 1);
    navigate("wizard");
  });
  DRAW[name](view, body, { back, next }, navigate);
  return section;
}
