import { env } from "@reactive-resume/env/server";

export function handleFirebaseConfig() {
	const isConfigured = Boolean(
		env.FIREBASE_PROJECT_ID &&
			env.FIREBASE_CLIENT_EMAIL &&
			env.FIREBASE_PRIVATE_KEY &&
			env.VITE_FIREBASE_API_KEY &&
			env.VITE_FIREBASE_AUTH_DOMAIN &&
			env.VITE_FIREBASE_PROJECT_ID,
	);

	return Response.json(
		isConfigured
			? {
					apiKey: env.VITE_FIREBASE_API_KEY,
					authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
					projectId: env.VITE_FIREBASE_PROJECT_ID,
				}
			: {},
		{ headers: { "Cache-Control": "no-store" } },
	);
}
