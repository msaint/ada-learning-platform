// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GuestCourseGate } from "@/components/course/guest-course-gate";
import { CourseSidebar } from "@/components/layout/course-sidebar";

beforeAll(() => {
  if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
      this.open = true;
    };
  }
  if (!HTMLDialogElement.prototype.close) {
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
      this.open = false;
    };
  }
});

const mockRefresh = vi.fn();
const mockPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh, push: mockPush }),
  usePathname: () => "/app",
}));

const mockApi = vi.fn();
vi.mock("@/lib/client/api", () => ({
  api: (...args: unknown[]) => mockApi(...args),
  ApiError: class ApiError extends Error {
    constructor(public code: string, message: string) {
      super(message);
    }
  },
}));

afterEach(() => {
  cleanup();
  mockRefresh.mockReset();
  mockPush.mockReset();
  mockApi.mockReset();
});

describe("GuestCourseGate", () => {
  it("offers Continue and Scrap (with confirmation) for an existing guest course and never shows the new-topic prompt", async () => {
    mockApi.mockResolvedValue({ deleted: true });
    render(
      <GuestCourseGate
        course={{
          id: "c-1",
          title: "Tapered Train Wheels",
          intent: "curiosity",
          updatedAt: new Date().toISOString(),
          nextActionLabel: "Continue",
          reviewDueCount: 0,
          hasOpenSession: true,
        }}
        draft={null}
      />,
    );

    expect(screen.queryByText("What would you like to learn?")).toBeNull();
    const continueLink = screen.getByRole("link", { name: /Continue “Tapered Train Wheels”/ });
    expect(continueLink.getAttribute("href")).toBe("/app/courses/c-1");

    await userEvent.click(screen.getByRole("button", { name: /Scrap it and create a new one/ }));
    expect(screen.getByRole("dialog", { name: /Scrap “Tapered Train Wheels”\?/ })).toBeTruthy();

    await userEvent.click(screen.getByRole("button", { name: "Scrap and start new" }));
    expect(mockApi).toHaveBeenCalledWith("/courses/c-1", { method: "DELETE" });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("offers Finish setting up and immediate Scrap for an unfinished guest draft", async () => {
    mockApi.mockResolvedValue({ deleted: true });
    render(
      <GuestCourseGate
        course={null}
        draft={{
          id: "d-1",
          topic: "Black holes",
          title: null,
          state: "collecting",
          updatedAt: new Date().toISOString(),
        }}
        openDraftIds={["d-1"]}
      />,
    );

    expect(screen.queryByText("What would you like to learn?")).toBeNull();
    const setupLink = screen.getByRole("link", { name: /Finish setting up “Black holes”/ });
    expect(setupLink.getAttribute("href")).toBe("/app/new?draft=d-1");

    await userEvent.click(screen.getByRole("button", { name: /Scrap it and create a new one/ }));
    expect(mockApi).toHaveBeenCalledWith("/course-drafts/d-1", { method: "DELETE" });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });
});

describe("CourseSidebar with unfinished drafts", () => {
  it("renders unfinished course drafts alongside active courses so nothing blocking a guest is hidden", async () => {
    mockApi.mockResolvedValue({ deleted: true });
    render(
      <CourseSidebar
        courses={[
          {
            id: "c-1",
            title: "Chess Openings",
            intent: "goal",
            updatedAt: new Date().toISOString(),
            nextActionLabel: null,
            reviewDueCount: 0,
            hasOpenSession: false,
          },
        ]}
        drafts={[
          {
            id: "d-2",
            topic: "Orbital mechanics",
            title: null,
            state: "collecting",
            updatedAt: new Date().toISOString(),
          },
        ]}
        user={{ email: null, displayName: null, isGuest: true }}
      />,
    );

    expect(screen.queryByText("Your courses will appear here")).toBeNull();
    expect(screen.getByRole("link", { name: /Orbital mechanics/ }).getAttribute("href")).toBe("/app/new?draft=d-2");
    expect(screen.getByRole("link", { name: /Chess Openings/ }).getAttribute("href")).toBe("/app/courses/c-1");

    await userEvent.click(screen.getByRole("button", { name: "Options for Orbital mechanics" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Scrap draft" }));
    expect(mockApi).toHaveBeenCalledWith("/course-drafts/d-2", { method: "DELETE" });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });
});
