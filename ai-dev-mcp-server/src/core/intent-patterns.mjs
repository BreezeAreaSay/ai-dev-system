const BOUNDARY_LEFT = "(?<![\\p{L}\\p{N}_])";
const BOUNDARY_RIGHT = "(?![\\p{L}\\p{N}_])";

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Create a Unicode-aware matcher that never accepts a partial token. */
export function intentPattern({ words = [], stems = [] } = {}) {
  const parts = [
    ...words.map((term) => escapeRegExp(term).replaceAll(" ", "\\s+")),
    ...stems.map((term) => `${escapeRegExp(term)}\\p{L}*`)
  ];
  if (!parts.length) return /$^/u;
  return new RegExp(`${BOUNDARY_LEFT}(?:${parts.join("|")})${BOUNDARY_RIGHT}`, "iu");
}

const diagramWords = intentPattern({
  words: ["diagram", "archify", "architecture diagram", "sequence diagram", "flowchart", "mermaid", "architecture map"],
  stems: ["диаграмм", "блок-схем"]
});
const diagramPhrases = "(?<![\\p{L}\\p{N}_])(?:схем\\p{L}*\\s+взаимодейств\\p{L}*|архитектур\\p{L}*\\s+карт\\p{L}*|визуализир\\p{L}*\\s+поток\\p{L}*)(?![\\p{L}\\p{N}_])";
const repositoryPhrases = "(?<![\\p{L}\\p{N}_])(?:оформ\\p{L}*|подготов\\p{L}*)\\s+(?:проект\\p{L}*|репозитор\\p{L}*)(?![\\p{L}\\p{N}_])";

export const INTENT = Object.freeze({
  diagram: new RegExp(`${diagramWords.source}|${diagramPhrases}`, "iu"),
  repository: new RegExp(`${intentPattern({
    words: ["repo", "repository", "onboard", "onboarding", "bootstrap", "agents.md"],
    stems: ["репозитор"]
  }).source}|${repositoryPhrases}`, "iu"),
  container: intentPattern({
    words: ["docker", "docker compose", "compose", "helm", "helm chart", "container", "kubernetes", "k8s"],
    stems: ["контейнер", "кубер"]
  }),
  frontend: intentPattern({
    words: ["frontend", "front-end", "ui", "ux", "react", "next.js", "vue", "svelte", "vite", "tailwind", "layout", "component", "screen", "interface", "css", "button", "form", "modal"],
    stems: ["интерфейс", "фронт", "верстк", "экран", "компонент", "кнопк", "форм", "модал"]
  }),
  highRisk: intentPattern({
    words: ["payment", "production", "deploy", "migration", "database", "security", "auth", "permission"],
    stems: ["удален", "продакшен", "депло", "миграц", "безопасн", "платеж"]
  })
});
