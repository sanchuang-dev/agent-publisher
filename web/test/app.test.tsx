import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, test } from "vitest";

import { App } from "../src/App.js";

afterEach(() => {
  cleanup();
  window.location.hash = "#/";
});

test("App renders takeover state from hash route in jsdom", async () => {
  window.location.hash = "#/task/waiting_for_login";
  render(<App />);

  await screen.findByText("请接管登录");
  await screen.findByText("控制权已让给你");
});
