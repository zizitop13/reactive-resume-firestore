import { beforeEach, describe, expect, it, vi } from "vitest";

const { env } = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }));

vi.mock("@reactive-resume/env/server", () => ({ env }));

import { handleFirebaseConfig } from "./firebase-config";

describe("Firebase runtime configuration", () => {
	beforeEach(() => {
		for (const key of Object.keys(env)) delete env[key];
	});

	it("returns public client values when Firebase configuration is complete", async () => {
		Object.assign(env, {
			FIREBASE_PROJECT_ID: "server-project",
			FIREBASE_CLIENT_EMAIL: "firebase@example.com",
			FIREBASE_PRIVATE_KEY: "private-key",
			VITE_FIREBASE_API_KEY: "public-api-key",
			VITE_FIREBASE_AUTH_DOMAIN: "example.firebaseapp.com",
			VITE_FIREBASE_PROJECT_ID: "web-project",
			FIREBASE_AUTH_EMULATOR_URL: "http://127.0.0.1:9099",
		});

		const response = handleFirebaseConfig();

		expect(response.headers.get("Cache-Control")).toBe("no-store");
		expect(await response.json()).toEqual({
			apiKey: "public-api-key",
			authDomain: "example.firebaseapp.com",
			projectId: "web-project",
			authEmulatorUrl: "http://127.0.0.1:9099",
		});
	});

	it("returns an empty object when server credentials are incomplete", async () => {
		Object.assign(env, {
			VITE_FIREBASE_API_KEY: "public-api-key",
			VITE_FIREBASE_AUTH_DOMAIN: "example.firebaseapp.com",
			VITE_FIREBASE_PROJECT_ID: "web-project",
		});

		expect(await handleFirebaseConfig().json()).toEqual({});
	});
});
