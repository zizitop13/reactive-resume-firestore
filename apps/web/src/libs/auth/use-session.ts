import { useEffect, useState } from "react";
import { authClient } from "./client";
import { getFirebaseSession, isFirebaseEnabled } from "./firebase";

export function useAuthSession() {
	const betterAuthSession = authClient.useSession();
	const [firebaseSession, setFirebaseSession] = useState<Awaited<ReturnType<typeof getFirebaseSession>>>(null);

	useEffect(() => {
		if (!isFirebaseEnabled) return;
		void getFirebaseSession().then(setFirebaseSession);
	}, []);

	return isFirebaseEnabled ? { data: firebaseSession } : betterAuthSession;
}
