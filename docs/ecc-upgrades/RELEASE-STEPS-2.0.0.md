# Выпуск 2.0.0: что нажать после мержа

Версия в `package.json` не создаёт релиз. Страница Releases показывала `v1.0.0` именно
поэтому: тега `v2.0.0` не существует, а всё остальное — формула Homebrew, PKGBUILD, образ в
GHCR — привязано к тегу, а не к файлу. Ниже порядок, в котором это разматывается.

Шаги 1–3 делаются один раз и занимают минуты. Шаги 4–6 — упаковка, их можно отложить, но до
них строка «формула ставит v1.0.0» в README остаётся правдой.

## 1. Слить PR в апстрим

Тег ставится на `main` апстрима (`stonebridgeway/ai-dev-system`), а не на ветку форка.

## 2. Тег

```bash
git clone https://github.com/stonebridgeway/ai-dev-system
cd ai-dev-system
git tag -a v2.0.0 -m "ai-dev-system 2.0.0"
git push origin v2.0.0
```

Тег `v*` запускает workflow `Docker`: он собирает и публикует
`ghcr.io/stonebridgeway/ai-dev-system:v2.0.0` для `linux/amd64` и `linux/arm64` — с SBOM и
provenance, и только после успешной validation job. Отдельно ничего запускать не нужно.

**Образ публикуется без BGE-M3**: `INSTALL_BGE_M3` по умолчанию `0`, весов в образе нет
никогда. Это осознанно — см. раздел про модель в контейнере в README.

## 3. Release

Текст готов: `docs/ecc-upgrades/RELEASE-NOTES-2.0.0.md` — целиком, как есть, в тело релиза.

Через веб: Releases → Draft a new release → тег `v2.0.0` → заголовок `ai-dev-system 2.0.0` →
вставить текст → Publish.

Через CLI:

```bash
gh release create v2.0.0 \
  --repo stonebridgeway/ai-dev-system \
  --title "ai-dev-system 2.0.0" \
  --notes-file docs/ecc-upgrades/RELEASE-NOTES-2.0.0.md
```

После этого страница Releases показывает 2.0.0. Это и был ответ на «тут ничего не
обновилось».

## 4. Homebrew

Формула раньше не могла указывать на 2.0.0: она пинит **неизменяемый** архив тега и его
SHA-256, а до шага 2 такого архива не существовало. Теперь существует.

```bash
VERSION=v2.0.0
curl -L --fail --silent --show-error \
  "https://github.com/stonebridgeway/ai-dev-system/archive/refs/tags/${VERSION}.tar.gz" \
  | shasum -a 256
```

В `packaging/homebrew/ai-dev-system.rb` заменить две строки: `url` (версия в пути) и `sha256`
(выведенный digest). Скопировать в `Formula/ai-dev-system.rb` в репозитории
`stonebridgeway/homebrew-tap`. На macOS перед коммитом:

```bash
brew style Formula/ai-dev-system.rb
brew audit --strict --formula Formula/ai-dev-system.rb
```

Подробности и чек-лист первой публикации tap — в `packaging/README.md`.

## 5. Arch

`packaging/arch/PKGBUILD`: `pkgver=1.0.0.r0.g9b7988d` → база `2.0.0`. Пакет собирается из
Git (`-git`), поэтому `pkgver()` считает версию сама; править нужно значение по умолчанию и
строку-запасной вариант внутри функции. После этого пересобрать `.SRCINFO`:

```bash
cd packaging/arch
makepkg --printsrcinfo > .SRCINFO
```

## 6. Строка в README

В `README.md` и `README.ru.md` — «Формула устанавливает стабильный релиз `v1.0.0`». Правится
после шага 4, не раньше: до него это правда.

## Чем проверить, что всё сошлось

| Что | Где смотреть | Чего ждать |
| --- | --- | --- |
| Релиз | Releases | `ai-dev-system 2.0.0`, не `v1.0.0` |
| Образ | Packages → `ai-dev-system` | тег `v2.0.0`, две архитектуры |
| Workflow | Actions → Docker | зелёный на теге, не только на `main` |
| Формула | `brew info ai-dev-system` | `2.0.0` |
