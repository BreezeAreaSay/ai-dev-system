#!/usr/bin/env node
import { emitContext,hooksDisabled,readStdin } from "./lib.mjs"; let calls=0; async function main(){await readStdin();if(!hooksDisabled("compact:advisor")&&++calls>=50)emitContext("PreToolUse","[ai-dev] Consider compacting: this session has many tool calls.");}main();
