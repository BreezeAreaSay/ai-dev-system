// The page: which screen shows, the language, the header. The main process
// tells the page where the daemon stands (connecting, online, offline, no
// Node); the page asks it to connect, and calls tools once online.
import * as api from "./api.js";
import { h, show } from "./dom.js";
import { pickLanguage, translate } from "./i18n.js";
import { statusScreen } from "./status.js";
import { wizardScreen } from "./wizard.js";

const screen = document.getElementById("screen");
const languageSelect = document.getElementById("language");

const view = {
  language: "en",
  connection: { phase: "connecting" },
  route: null,
  t: (key, params) => translate(view.language, key, params)
};

function translateStatic() {
  document.documentElement.lang = view.language;
  document.title = view.t("app.title");
  for (const element of document.querySelectorAll("[data-i18n]")) element.textContent = view.t(element.dataset.i18n);
  languageSelect.value = view.language;
}

function focusHeading() {
  screen.querySelector("h1")?.focus();
}

function connectingScreen() {
  return h("section", { className: "centre", dataset: { screen: "connecting" } },
    h("h1", { tabindex: "-1" }, view.t("connect.title")),
    h("div", { className: "spinner", role: "presentation" }));
}

/** A Try again button, for a screen whose cause the person can fix while the app runs. */
function retryButton(label) {
  const button = h("button", {
    type: "button",
    className: "primary",
    id: "retry",
    on: {
      async click() {
        button.disabled = true;
        await api.retry();
        button.disabled = false;
      }
    }
  }, label);
  return button;
}

function noNodeScreen() {
  return h("section", { className: "centre", dataset: { screen: "no-node" } },
    h("h1", { tabindex: "-1" }, view.t("node.title")),
    h("p", {}, view.t("node.body")),
    view.connection.error ? h("p", { className: "muted" }, view.connection.error) : null,
    retryButton(view.t("common.retry")));
}

/** The app could not get going: what stopped it, what to do, and Try again or Restart (Д-242). */
function brokenScreen() {
  const { connection } = view;
  return h("section", { className: "centre", dataset: { screen: "broken" } },
    h("h1", { tabindex: "-1" }, view.t("broken.title")),
    h("p", { className: "error", role: "alert", dataset: { field: "broken-error" } }, connection.error ?? ""),
    connection.hint ? h("p", { dataset: { field: "broken-hint" } }, connection.hint) : null,
    retryButton(view.t(connection.restart ? "broken.restart" : "common.retry")),
    connection.detail ? h("details", { className: "log" }, h("summary", {}, view.t("broken.detail")), h("pre", {}, connection.detail)) : null);
}

function offlineScreen() {
  const { connection } = view;
  const starting = connection.phase === "starting";
  const start = h("button", {
    type: "button",
    className: "primary",
    id: "start-daemon",
    disabled: starting,
    on: { click: () => api.connect(true) }
  }, view.t(starting ? "offline.starting" : "offline.start"));
  return h("section", { className: "centre", dataset: { screen: "offline" } },
    h("h1", { tabindex: "-1" }, view.t("offline.title")),
    h("p", {}, view.t("offline.body")),
    start,
    connection.error ? h("p", { className: "error", role: "alert", dataset: { field: "offline-error" } }, h("span", { className: "label" }, `${view.t("offline.reason")}: `), connection.error) : null,
    connection.log?.length
      ? h("details", { className: "log" }, h("summary", {}, view.t("offline.log")), h("pre", {}, connection.log.join("\n")))
      : null);
}

async function render() {
  translateStatic();
  const { phase } = view.connection;
  document.body.dataset.phase = phase;
  if (phase === "connecting" || phase === "reconnecting") return show(screen, connectingScreen());
  if (phase === "no-node") return show(screen, noNodeScreen());
  if (phase === "broken") return show(screen, brokenScreen());
  if (phase !== "online") return show(screen, offlineScreen());
  if (!view.route) view.route = view.connection.needsSetup ? "wizard" : "status";
  const navigate = (route) => {
    view.route = route;
    render();
  };
  const content = view.route === "wizard" ? wizardScreen(view, navigate) : statusScreen(view, navigate);
  show(screen, content);
  focusHeading();
  return undefined;
}

for (const button of document.querySelectorAll("[data-nav]")) {
  button.addEventListener("click", () => {
    if (view.connection.phase !== "online") return;
    view.route = button.dataset.nav;
    render();
  });
}

languageSelect.addEventListener("change", async () => {
  view.language = pickLanguage(languageSelect.value, "");
  // The state comes back in the new language: the link's own words too (Д-283, п. 3).
  const connection = await api.setLanguage(view.language);
  if (connection) {
    view.connection = connection;
    // The main process's language after the choice: a state sent meanwhile does not undo it (Д-284).
    if (connection.language) view.language = connection.language;
  }
  render();
});

api.onState((connection) => {
  const was = view.connection.phase;
  const spoken = view.language;
  view.connection = connection ?? { phase: "offline" };
  if (connection?.language) view.language = connection.language;
  // A screen in the middle of a step keeps its place while the daemon is
  // reachable, and across a reconnect (the daemon of new code, Д-245); any
  // other change of phase draws the page again from the start.
  if (was !== view.connection.phase) {
    if (!["online", "reconnecting"].includes(view.connection.phase)) view.route = null;
    render();
  } else if (["offline", "broken", "no-node"].includes(view.connection.phase) || view.language !== spoken) {
    // The same screen with news: a log that arrived, a reason that changed —
    // or the language, which the main process changed: the settings file,
    // fixed, named its own (Д-283, п. 2).
    render();
  }
});

const initial = await api.state();
view.connection = initial;
view.language = initial.language ?? pickLanguage("", navigator.language);
render();
