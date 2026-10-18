; The uninstaller's own step (docs/DESKTOP.md, "The Windows install"),
; included by electron-builder's NSIS script. It runs before the program's
; files are removed, while the runtime it ships is still there: its Node runs
; `ai-dev uninstall`, which stops the daemon and removes the runtime copies the
; app made in the AI Dev home and the link AI clients run
; (ai-dev-mcp-server/src/core/bundle-uninstall.mjs).
;
; Two questions first: take AI Dev out of the AI clients' settings (Yes by
; default: their entries run the runtime that is going), and delete AI Dev's
; own data (No by default). A silent uninstall answers the defaults. An
; update runs the old uninstaller too: then nothing of this happens.
;
; The strings are named by language id — 1033 English, 1049 Russian: this
; file is included before the installer loads its languages, when the
; ${LANG_*} names are not defined yet.

LangString aiDevRemoveClients 1033 "Remove AI Dev from your AI clients' settings (Claude, Cursor, VS Code, Codex, Gemini)?$\r$\n$\r$\nTheir AI Dev entries run the program you are removing and would stop working."
LangString aiDevRemoveClients 1049 "Убрать AI Dev из настроек ваших AI-клиентов (Claude, Cursor, VS Code, Codex, Gemini)?$\r$\n$\r$\nИх записи AI Dev запускают удаляемую программу и перестанут работать."
LangString aiDevRemoveData 1033 "Also delete AI Dev's data in your profile's .ai-dev folder: tasks and decisions, the local model, the search index, the settings?$\r$\n$\r$\nYour projects are not touched."
LangString aiDevRemoveData 1049 "Удалить и данные AI Dev в папке .ai-dev вашего профиля: задачи и решения, локальную модель, поисковый индекс, настройки?$\r$\n$\r$\nВаши проекты не затрагиваются."

!macro customUnInstall
  ${ifNot} ${isUpdated}
    StrCpy $R5 "--clients"
    StrCpy $R6 ""
    MessageBox MB_YESNO|MB_ICONQUESTION "$(aiDevRemoveClients)" /SD IDYES IDYES aiDevKeepClientsAnswered
      StrCpy $R5 ""
    aiDevKeepClientsAnswered:
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "$(aiDevRemoveData)" /SD IDNO IDNO aiDevKeepDataAnswered
      StrCpy $R6 "--data"
    aiDevKeepDataAnswered:
    ${if} ${FileExists} "$INSTDIR\resources\runtime\node\node.exe"
      nsExec::ExecToLog '"$INSTDIR\resources\runtime\node\node.exe" "$INSTDIR\resources\runtime\ai-dev-mcp-server\bin\ai-dev.mjs" uninstall --yes $R5 $R6'
      Pop $R7
      DetailPrint "ai-dev uninstall: $R7"
    ${endIf}
  ${endIf}
!macroend
