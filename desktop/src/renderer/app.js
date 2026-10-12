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

function noNodeScreen() {
  return h("section", { className: "centre", dataset: { screen: "no-node" } },
    h("h1", { tabindex: "-1" }, view.t("node.title")),
    h("p", {}, view.t("node.body")),
    view.connection.error ? h("p", { className: "muted" }, view.connection.error) : null);
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
    connection.error ? h("p", { className: "error", role: "alert" }, view.t("offline.failed", { message: connection.error })) : null,
    connection.log?.length
      ? h("details", { className: "log" }, h("summary", {}, view.t("offline.log")), h("pre", {}, connection.log.join("\n")))
      : null);
}

async function render() {
  translateStatic();
  const { phase } = view.connection;
  document.body.dataset.phase = phase;
  if (phase === "connecting") return show(screen, connectingScreen());
  if (phase === "no-node") return show(screen, noNodeScreen());
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
  await api.setLanguage(view.language);
  render();
});

api.onState((connection) => {
  const was = view.connection.phase;
  view.connection = connection ?? { phase: "offline" };
  if (connection?.language) view.language = connection.language;
  // A screen in the middle of a step keeps its place while the daemon is
  // reachable; a change of phase draws the page again.
  if (was !== view.connection.phase) {
    if (view.connection.phase !== "online") view.route = null;
    render();
  }
});

const initial = await api.state();
view.connection = initial;
view.language = initial.language ?? pickLanguage("", navigator.language);
render();
