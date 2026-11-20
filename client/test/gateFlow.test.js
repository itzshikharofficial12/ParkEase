import { dom } from "./setupDom.js";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AuthContext } from "../src/context/authContextInstance.js";
import { signIn } from "../src/services/authService.js";
import { normalizeBookingsResponse } from "../src/services/bookingService.js";
import GateConsolePage from "../src/pages/GateConsolePage.jsx";
import BookingPass from "../src/components/BookingPass.jsx";
import GuardsPage from "../src/pages/GuardsPage.jsx";
import Modal from "../src/components/Modal.jsx";

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });

const token = "a".repeat(64);
const booking = { _id: "booking-1", mallId: "mall-1", mallName: "Test Mall", slotCode: "A01", floor: "B1", vehicleNumber: "DL01AB1234", vehicleType: "CAR", status: "CONFIRMED", qrEligiblePurposes: ["ENTRY"], entryDeadline: new Date(Date.now() + 600000).toISOString() };
const reply = (data, status = 200) => new Response(JSON.stringify({ success: status < 400, data }), { status, headers: { "Content-Type": "application/json" } });
async function session(role, handler) {
  const user = { _id: "test-user", role, status: "ACTIVE" };
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(url).pathname.replace("/api", "");
    if (path === "/auth/login") return reply({ user, accessToken: "test-access-token" });
    return handler(path, options);
  };
  await signIn("login", { email: "test@example.com", password: "test-password" });
  return user;
}
const assignments = () => reply({ assignments: [{ mallId: "mall-1", mallName: "Test Mall", gateLabel: "North" }] });
function mount(Component, user, props = {}) {
  return render(React.createElement(MemoryRouter, null, React.createElement(AuthContext.Provider, { value: { user } }, React.createElement(Component, props))));
}

test("Guard verifies before entry and retries an uncertain confirmation with the identical operation reference", async () => {
  const writes = [];
  const user = await session("GUARD", (path, options) => {
    if (path === "/guards/my-assignments") return assignments();
    if (path === "/qr/verify") return reply({ allowed: true, booking });
    if (path === "/operations/entry") {
      writes.push(JSON.parse(options.body));
      if (writes.length === 1) throw new Error("Network interrupted");
      return reply({ booking: { ...booking, status: "ACTIVE" }, operation: { id: writes[0].operationId, action: "ENTRY", occurredAt: new Date().toISOString() } });
    }
    throw new Error(`Unexpected request: ${path}`);
  });
  const view = mount(GateConsolePage, user);
  const field = await view.findByLabelText(/Driver's manual credential/);
  fireEvent.change(field, { target: { value: token } });
  fireEvent.submit(field.closest("form"));
  await view.findByText("Pass verified — check the vehicle");
  assert.equal(writes.length, 0, "Verification must never admit a vehicle");
  fireEvent.click(view.getByRole("button", { name: "Confirm vehicle entry" }));
  const retry = await view.findByRole("button", { name: "Retry same entry" });
  assert.equal(view.getByRole("combobox", { name: "Assigned mall" }).disabled, true);
  assert.equal(field.disabled, true);
  fireEvent.click(retry);
  await view.findByText("Entry confirmed");
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0], writes[1]);
  assert.ok(!view.queryByRole("button", { name: "Confirm vehicle entry" }), "Unverified or changed credentials cannot be confirmed");
});

test("Guard rejects expired passes and clears verified details when credentials change", async () => {
  let allowed = false;
  const user = await session("GUARD", (path) => {
    if (path === "/guards/my-assignments") return assignments();
    if (path === "/qr/verify") return reply({ allowed, booking, reasonCode: allowed ? null : "TOKEN_EXPIRED" });
    throw new Error(`Unexpected mutation: ${path}`);
  });
  const view = mount(GateConsolePage, user);
  const field = await view.findByLabelText(/Driver's manual credential/);
  fireEvent.change(field, { target: { value: token } });
  fireEvent.submit(field.closest("form"));
  await view.findByText(/This pass has expired/);
  assert.ok(!view.queryByRole("button", { name: "Confirm vehicle entry" }), "Unverified or changed credentials cannot be confirmed");
  allowed = true;
  fireEvent.submit(field.closest("form"));
  await view.findByText("Pass verified — check the vehicle");
  fireEvent.change(field, { target: { value: "b".repeat(64) } });
  assert.ok(!view.queryByRole("button", { name: "Confirm vehicle entry" }), "Unverified or changed credentials cannot be confirmed");
});

test("Confirmed exit shows the server-calculated bill", async () => {
  const user = await session("GUARD", (path, options) => {
    if (path === "/guards/my-assignments") return assignments();
    if (path === "/qr/verify") { assert.equal(JSON.parse(options.body).action, "EXIT"); return reply({ allowed: true, booking: { ...booking, status: "ACTIVE" } }); }
    if (path === "/operations/exit") return reply({ booking: { ...booking, status: "COMPLETED" }, operation: { id: "exit-1", action: "EXIT", occurredAt: new Date().toISOString() }, bill: { calculatedAmountPaise: 5000, durationMinutes: 65, billableHours: 2 } });
    throw new Error(`Unexpected request: ${path}`);
  });
  const view = mount(GateConsolePage, user);
  await view.findByLabelText(/Driver's manual credential/);
  fireEvent.click(view.getByRole("button", { name: "Exit", exact: true }));
  const field = view.getByLabelText(/Driver's manual credential/);
  fireEvent.change(field, { target: { value: token } });
  fireEvent.submit(field.closest("form"));
  fireEvent.click(await view.findByRole("button", { name: "Confirm vehicle exit" }));
  await view.findByText("Exit confirmed");
  assert.match(view.container.textContent, /Final bill: ₹50\.00/);
  assert.match(view.container.textContent, /65 minutes · 2 billable hours/);
});

test("Driver QR uses canonical eligibility, renders locally, and replaces the manual credential", async () => {
  let issues = 0;
  const user = await session("USER", (path) => {
    assert.equal(path, "/bookings/booking-1/qr");
    issues++;
    return reply({ token: (issues === 1 ? "a" : "b").repeat(64), purpose: "ENTRY", expiresAt: new Date(Date.now() + 300000).toISOString() });
  });
  const normalized = normalizeBookingsResponse([booking]).bookings[0];
  assert.deepEqual(normalized.qrEligiblePurposes, ["ENTRY"]);
  const view = mount(BookingPass, user, { booking: normalized });
  fireEvent.click(view.getByRole("button", { name: "Generate entry pass" }));
  const image = await view.findByAltText("entry QR pass for A01");
  assert.match(image.src, /^data:image\/png;base64,/);
  fireEvent.click(view.getByRole("button", { name: "Generate replacement pass" }));
  await waitFor(() => assert.equal(view.container.querySelector("code")?.textContent, "b".repeat(64)));
  assert.equal(issues, 2);
});

test("Guard creation resets the form after the async request and refreshes assignments", async () => {
  let created = false;
  const user = await session("MALL_OWNER", (path, options) => {
    if (path === "/malls/owner/my-malls") return reply({ malls: [{ _id: "mall-1", name: "Test Mall", status: "APPROVED" }] });
    if (path === "/malls/mall-1/guards" && options.method === "POST") { created = true; return reply({ guard: { name: "New Guard" } }); }
    if (path === "/malls/mall-1/guards") return reply({ guards: created ? [{ user: { name: "New Guard", email: "guard@test.com" }, assignment: { id: "assignment-1", isActive: true } }] : [] });
    throw new Error(`Unexpected request: ${path}`);
  });
  const view = mount(GuardsPage, user);
  await view.findByRole("option", { name: "Test Mall" });
  fireEvent.change(view.getByLabelText("Selected mall"), { target: { value: "mall-1" } });
  const name = await view.findByLabelText(/Full name/);
  fireEvent.change(name, { target: { value: "New Guard" } });
  fireEvent.change(view.getByLabelText(/^Email/), { target: { value: "guard@test.com" } });
  fireEvent.change(view.getByLabelText(/Temporary password/), { target: { value: "temporary-password-1" } });
  fireEvent.submit(name.closest("form"));
  await view.findByText(/Guard created\. Share/);
  await view.findByText(/guard@test.com/);
  assert.equal(name.value, "");
  assert.ok(!view.queryByRole("alert"));
});

test("Modal remains accessible, traps keyboard focus, closes on Escape, and restores the opener", async () => {
  const opener = document.createElement("button"); document.body.append(opener); opener.focus();
  const originalRects = dom.window.HTMLElement.prototype.getClientRects;
  dom.window.HTMLElement.prototype.getClientRects = () => [{ width: 10, height: 10 }];
  let closed = false;
  try {
    const view = render(React.createElement(Modal, { isOpen: true, title: "Confirm parking", onClose: () => { closed = true; } }, React.createElement("button", null, "Last action")));
    const dialog = view.getByRole("dialog");
    assert.equal(dialog.closest('[aria-hidden="true"]'), null);
    const last = view.getByRole("button", { name: "Last action" }); last.focus();
    fireEvent.keyDown(last, { key: "Tab" });
    assert.ok(document.activeElement === view.getByRole("button", { name: "Close dialog" }));
    fireEvent.keyDown(dialog, { key: "Escape" }); assert.equal(closed, true);
    view.unmount(); assert.ok(document.activeElement === opener);
  } finally { dom.window.HTMLElement.prototype.getClientRects = originalRects; opener.remove(); }
});

test("Role switches return users to an allowed destination and prioritize temporary-password setup", async () => {
  const { authDestination } = await import("../src/utils/authDestination.js");
  assert.equal(authDestination({ role: "GUARD" }, { pathname: "/dashboard/bookings/old" }), "/dashboard/operations");
  assert.equal(authDestination({ role: "USER" }, { pathname: "/dashboard/operations" }), "/dashboard");
  assert.equal(authDestination({ role: "USER" }, { pathname: "/dashboard/bookings/current" }), "/dashboard/bookings/current");
  assert.equal(authDestination({ role: "GUARD", mustChangePassword: true }, { pathname: "/dashboard/operations" }), "/dashboard/profile");
  assert.equal(authDestination({ role: "USER" }, { pathname: "//untrusted.example" }), "/dashboard");
});

test("Expired driver credentials disappear and cannot be copied", async () => {
  const user = await session("USER", () => reply({ token, purpose: "ENTRY", expiresAt: new Date(Date.now() - 1000).toISOString() }));
  const view = mount(BookingPass, user, { booking: normalizeBookingsResponse([booking]).bookings[0] });
  fireEvent.click(view.getByRole("button", { name: "Generate entry pass" }));
  await view.findByText(/This pass has expired/);
  assert.ok(!view.queryByAltText("entry QR pass for A01"));
  assert.ok(!view.queryByRole("button", { name: "Copy credential" }));
});

test("Missing camera support leaves the guard's manual credential workflow available", async () => {
  const user = await session("GUARD", (path) => {
    assert.equal(path, "/guards/my-assignments"); return assignments();
  });
  const view = mount(GateConsolePage, user);
  await view.findByLabelText(/Driver's manual credential/);
  fireEvent.click(view.getByRole("button", { name: "Scan QR with camera" }));
  await view.findByText(/Camera scanning requires HTTPS or localhost/);
  assert.equal(view.getByLabelText(/Driver's manual credential/).disabled, false);
  fireEvent.click(view.getByRole("button", { name: "Close camera", exact: true }));
  assert.ok(!view.queryByLabelText("QR camera preview"));
});
