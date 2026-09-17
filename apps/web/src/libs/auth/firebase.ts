import type { AuthSession } from "@reactive-resume/auth/types";
import type { User } from "firebase/auth";
import { getApp, getApps, initializeApp } from "firebase/app";
import {
	createUserWithEmailAndPassword,
	signOut as firebaseSignOut,
	GoogleAuthProvider,
	getAuth,
	onAuthStateChanged,
	sendPasswordResetEmail,
	signInWithEmailAndPassword,
	signInWithPopup,
	updateProfile,
} from "firebase/auth";
import { slugify } from "@reactive-resume/utils/string";

const firebaseConfig = {
	apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
	authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
	projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
};

export const isFirebaseEnabled = Boolean(
	firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.projectId,
);

const getFirebaseAuth = () => {
	if (!isFirebaseEnabled) throw new Error("Firebase web credentials are not configured");
	const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
	return getAuth(app);
};

const toSession = (user: NonNullable<ReturnType<typeof getFirebaseAuth>["currentUser"]>): AuthSession => {
	const now = new Date();
	return {
		user: {
			id: user.uid,
			name: user.displayName ?? user.email?.split("@")[0] ?? "User",
			email: user.email ?? `${user.uid}@firebase.local`,
			emailVerified: user.emailVerified,
			image: user.photoURL,
			createdAt: now,
			updatedAt: now,
			username: slugify(user.displayName ?? user.email?.split("@")[0] ?? user.uid),
			displayUsername: user.displayName ?? user.email?.split("@")[0] ?? user.uid,
			twoFactorEnabled: false,
			role: "user",
			banned: false,
			banReason: null,
			banExpires: null,
			lastActiveAt: now,
		},
		session: {
			id: user.uid,
			token: "firebase",
			userId: user.uid,
			expiresAt: new Date(Date.now() + 60 * 60 * 1000),
			createdAt: now,
			updatedAt: now,
			ipAddress: null,
			userAgent: null,
			impersonatedBy: null,
		},
	} as AuthSession;
};

export async function getFirebaseSession(): Promise<AuthSession | null> {
	const auth = getFirebaseAuth();
	const user =
		auth.currentUser ??
		(await new Promise<User | null>((resolve) => {
			const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
				unsubscribe();
				resolve(nextUser);
			});
		}));
	return user ? toSession(user) : null;
}

export function getFirebaseIdToken(): Promise<string | null> | null {
	return getFirebaseAuth().currentUser?.getIdToken() ?? null;
}

export function signInWithFirebase(email: string, password: string) {
	return signInWithEmailAndPassword(getFirebaseAuth(), email, password);
}

export async function signUpWithFirebase(name: string, email: string, password: string) {
	const credential = await createUserWithEmailAndPassword(getFirebaseAuth(), email, password);
	await updateProfile(credential.user, { displayName: name });
	return credential;
}

export function signInWithGoogleFirebase() {
	return signInWithPopup(getFirebaseAuth(), new GoogleAuthProvider());
}

export function requestFirebasePasswordReset(email: string) {
	return sendPasswordResetEmail(getFirebaseAuth(), email);
}

export function signOutFirebase() {
	return firebaseSignOut(getFirebaseAuth());
}
