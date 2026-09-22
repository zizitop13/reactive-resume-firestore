import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { env } from "@reactive-resume/env/server";

export const isFirebaseConfigured = Boolean(
	env.FIREBASE_PROJECT_ID &&
		env.FIREBASE_CLIENT_EMAIL &&
		env.FIREBASE_PRIVATE_KEY &&
		env.VITE_FIREBASE_API_KEY &&
		env.VITE_FIREBASE_AUTH_DOMAIN &&
		env.VITE_FIREBASE_PROJECT_ID,
);

function getFirebaseApp() {
	if (!isFirebaseConfigured) throw new Error("Firebase credentials are not configured");
	const projectId = env.FIREBASE_PROJECT_ID;
	const clientEmail = env.FIREBASE_CLIENT_EMAIL;
	const privateKey = env.FIREBASE_PRIVATE_KEY;
	if (!projectId || !clientEmail || !privateKey) throw new Error("Firebase Admin credentials are incomplete");

	const useEmulators = Boolean(env.FIRESTORE_EMULATOR_HOST && env.FIREBASE_AUTH_EMULATOR_HOST);

	return (
		getApps()[0] ??
		initializeApp(
			useEmulators
				? { projectId }
				: {
						credential: cert({
							projectId,
							clientEmail,
							privateKey: privateKey.replace(/\\n/g, "\n"),
						}),
					},
		)
	);
}

export const getFirebaseAuth = () => getAuth(getFirebaseApp());
export const getFirebaseFirestore = () => getFirestore(getFirebaseApp());
