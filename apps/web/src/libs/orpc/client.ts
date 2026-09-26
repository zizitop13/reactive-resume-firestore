import type { InferRouterInputs, InferRouterOutputs, RouterClient } from "@orpc/server";
import type router from "@reactive-resume/api/routers";
import { createORPCClient, onError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { BatchLinkPlugin } from "@orpc/client/plugins";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { getFirebaseIdToken, isFirebaseEnabled } from "../auth/firebase";

const getRpcUrl = () => {
	if (typeof window === "undefined") return "http://localhost:3000/api/rpc";
	return `${window.location.origin}/api/rpc`;
};

const authenticatedFetch: typeof fetch = async (request, init) => {
	const headers = new Headers(init?.headers);
	if (isFirebaseEnabled && typeof window !== "undefined") {
		const token = await getFirebaseIdToken();
		if (token) headers.set("Authorization", `Bearer ${token}`);
	}
	return fetch(request, { ...init, headers, credentials: "include" });
};

export const client: RouterClient<typeof router> = createORPCClient(
	new RPCLink({
		url: getRpcUrl(),
		fetch: authenticatedFetch,
		plugins: [
			new BatchLinkPlugin({
				mode: "streaming",
				groups: [{ condition: () => true, context: {} }],
			}),
		],
		interceptors: [
			onError((error) => {
				if (error instanceof DOMException && error.name === "AbortError") return;
				console.warn("[oRPC client]", error);
			}),
		],
	}),
);

export const streamClient: RouterClient<typeof router> = createORPCClient(
	new RPCLink({
		url: getRpcUrl(),
		fetch: authenticatedFetch,
		interceptors: [
			onError((error) => {
				if (error instanceof DOMException && error.name === "AbortError") return;
				console.warn("[oRPC stream client]", error);
			}),
		],
	}),
);

export const orpc = createTanstackQueryUtils(client);

export type RouterInput = InferRouterInputs<typeof router>;

export type RouterOutput = InferRouterOutputs<typeof router>;
