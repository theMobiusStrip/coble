#!/usr/bin/env node
import { Command } from "commander";
import { render } from "ink";
import { App } from "./ui/App.js";
import { VERSION } from "./version.js";

const program = new Command();

program
  .name("coble")
  .description("Local, provider-agnostic agent CLI — LangGraph.js core, Ink TUI")
  .version(VERSION)
  .action(() => {
    render(<App />);
  });

await program.parseAsync();
