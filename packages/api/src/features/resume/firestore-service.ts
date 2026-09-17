import type { JsonPatchOperation } from "@reactive-resume/resume/patch";
import type { ResumeData } from "@reactive-resume/schema/resume/data";
import type { Locale } from "@reactive-resume/utils/locale";
import { ORPCError } from "@orpc/client";
import { compare, hash } from "bcrypt";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { applyResumePatches, ResumePatchError } from "@reactive-resume/resume/patch";
import { defaultResumeData } from "@reactive-resume/schema/resume/default";
import { generateId, slugify } from "@reactive-resume/utils/string";
import { getFirebaseAuth, getFirebaseFirestore } from "../firebase/admin";
import { getStorageService } from "../storage/service";
import { grantResumeAccess, hasResumeAccess } from "./access";
import { assertCanView, isOwner, redactResumeForViewer, shouldCountForStatistics } from "./access-policy";
import { publishResumeUpdated } from "./events";
import { parseStoredResumeData, parseWritableResumeData } from "./resume-data-validation";
import { clientKeyFromHeaders, shouldCountView } from "./view-dedup";

const RESUMES = "resumes";
const MAX_VERSIONS = 30;

type StoredResume = {
	id: string;
	userId: string;
	ownerUsername: string;
	name: string;
	slug: string;
	tags: string[];
	data: ResumeData;
	isPublic: boolean;
	isLocked: boolean;
	showDownloadButtons: boolean;
	password: string | null;
	createdAt: Timestamp;
	updatedAt: Timestamp;
	views?: number;
	downloads?: number;
	lastViewedAt?: Timestamp | null;
	lastDownloadedAt?: Timestamp | null;
};

const db = () => getFirebaseFirestore();
const ref = (id: string) => db().collection(RESUMES).doc(id);
const toDate = (value: Timestamp | Date) => (value instanceof Timestamp ? value.toDate() : value);

function publicResume(resume: StoredResume) {
	return {
		id: resume.id,
		name: resume.name,
		slug: resume.slug,
		tags: resume.tags,
		data: parseStoredResumeData(resume.data),
		isPublic: resume.isPublic,
		isLocked: resume.isLocked,
		showDownloadButtons: resume.showDownloadButtons,
		updatedAt: toDate(resume.updatedAt),
		hasPassword: Boolean(resume.password),
	};
}

async function loadOwned(id: string, userId: string): Promise<StoredResume> {
	const snapshot = await ref(id).get();
	const resume = snapshot.data() as StoredResume | undefined;
	if (!resume || resume.userId !== userId) throw new ORPCError("NOT_FOUND");
	return resume;
}

async function ownerUsername(userId: string) {
	const user = await getFirebaseAuth().getUser(userId);
	return `${slugify(user.displayName ?? user.email?.split("@")[0] ?? "user")}-${user.uid}`;
}

async function assertUniqueSlug(userId: string, slug: string, excludedId?: string) {
	const snapshot = await db().collection(RESUMES).where("userId", "==", userId).where("slug", "==", slug).get();
	if (snapshot.docs.some((document) => document.id !== excludedId)) {
		throw new ORPCError("RESUME_SLUG_ALREADY_EXISTS", { status: 400 });
	}
}

async function notify(
	resumeId: string,
	userId: string,
	mutation: "create" | "update" | "patch" | "lock" | "password" | "delete",
) {
	try {
		await publishResumeUpdated({
			type: "resume.updated",
			resumeId,
			userId,
			updatedAt: new Date().toISOString(),
			mutation,
		});
	} catch (error) {
		console.warn("Failed to publish resume.updated event:", error);
	}
}

async function snapshotVersion(input: { resumeId: string; userId: string; data: ResumeData; label: string }) {
	const resume = await loadOwned(input.resumeId, input.userId);
	const versions = ref(resume.id).collection("versions");
	await versions.add({
		data: parseWritableResumeData(input.data),
		label: input.label,
		createdAt: FieldValue.serverTimestamp(),
	});
	const stale = await versions.orderBy("createdAt", "desc").offset(MAX_VERSIONS).get();
	const batch = db().batch();
	for (const document of stale.docs) batch.delete(document.ref);
	if (!stale.empty) await batch.commit();
}

const statistics = {
	increment: async (input: { id: string; views?: boolean; downloads?: boolean }) => {
		const now = Timestamp.now();
		const today = now.toDate().toISOString().slice(0, 10);
		const resumeRef = ref(input.id);
		const dailyRef = resumeRef.collection("statisticsDaily").doc(today);
		await db().runTransaction((transaction) => {
			transaction.update(resumeRef, {
				...(input.views ? { views: FieldValue.increment(1), lastViewedAt: now } : {}),
				...(input.downloads ? { downloads: FieldValue.increment(1), lastDownloadedAt: now } : {}),
			});
			transaction.set(
				dailyRef,
				{
					date: today,
					views: FieldValue.increment(input.views ? 1 : 0),
					downloads: FieldValue.increment(input.downloads ? 1 : 0),
				},
				{ merge: true },
			);
			return Promise.resolve();
		});
	},
	getById: async (input: { id: string; userId: string }) => {
		const resume = await loadOwned(input.id, input.userId);
		return {
			isPublic: resume.isPublic,
			views: resume.views ?? 0,
			downloads: resume.downloads ?? 0,
			lastViewedAt: resume.lastViewedAt ? toDate(resume.lastViewedAt) : null,
			lastDownloadedAt: resume.lastDownloadedAt ? toDate(resume.lastDownloadedAt) : null,
		};
	},
	getDailySeries: async (input: { id: string; userId: string; days?: number }) => {
		await loadOwned(input.id, input.userId);
		const days = input.days ?? 30;
		const now = new Date();
		const utcDay = (offset: number) =>
			new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - offset)).toISOString().slice(0, 10);
		const dates = Array.from({ length: days }, (_, index) => utcDay(days - 1 - index));
		const rows = await ref(input.id).collection("statisticsDaily").where("date", ">=", dates[0]).get();
		const byDate = new Map(rows.docs.map((document) => [document.id, document.data()]));
		return dates.map((date) => ({
			date,
			views: byDate.get(date)?.views ?? 0,
			downloads: byDate.get(date)?.downloads ?? 0,
		}));
	},
	recordDownload: async (input: {
		username: string;
		slug: string;
		requestHeaders: Headers;
		currentUserId?: string;
	}) => {
		const resume = await findBySlug(input.username, input.slug);
		const viewer = input.currentUserId ? { id: input.currentUserId } : null;
		assertCanView(resume, viewer);
		if (resume.password && !hasResumeAccess(input.requestHeaders, resume.id, resume.password)) {
			throw new ORPCError("NEED_PASSWORD", { status: 401, data: { username: input.username, slug: input.slug } });
		}
		if (shouldCountForStatistics(resume, viewer)) await statistics.increment({ id: resume.id, downloads: true });
		return true;
	},
};

async function findBySlug(username: string, slug: string): Promise<StoredResume> {
	const snapshot = await db()
		.collection(RESUMES)
		.where("ownerUsername", "==", username)
		.where("slug", "==", slug)
		.limit(1)
		.get();
	const resume = snapshot.docs[0]?.data() as StoredResume | undefined;
	if (!resume) throw new ORPCError("NOT_FOUND");
	return resume;
}

export const firestoreResumeService = {
	tags: {
		list: async ({ userId }: { userId: string }) => {
			const snapshot = await db().collection(RESUMES).where("userId", "==", userId).get();
			return [...new Set(snapshot.docs.flatMap((document) => (document.data() as StoredResume).tags))].sort();
		},
	},
	statistics,
	versions: {
		list: async ({ resumeId, userId }: { resumeId: string; userId: string }) => {
			await loadOwned(resumeId, userId);
			const snapshot = await ref(resumeId)
				.collection("versions")
				.orderBy("createdAt", "desc")
				.limit(MAX_VERSIONS)
				.get();
			return snapshot.docs.map((document) => ({
				id: document.id,
				label: document.data().label as string,
				createdAt: (document.data().createdAt as Timestamp).toDate(),
			}));
		},
		snapshot: snapshotVersion,
		restore: async ({ resumeId, versionId, userId }: { resumeId: string; versionId: string; userId: string }) => {
			const current = await loadOwned(resumeId, userId);
			if (current.isLocked) throw new ORPCError("RESUME_LOCKED");
			const version = await ref(resumeId).collection("versions").doc(versionId).get();
			if (!version.exists) throw new ORPCError("NOT_FOUND");
			await snapshotVersion({ resumeId, userId, data: current.data, label: "Before restore" });
			return firestoreResumeService.update({
				id: resumeId,
				userId,
				data: version.data()?.data,
				skipAutoSnapshot: true,
			});
		},
	},
	list: async (input: { userId: string; tags: string[]; sort: "lastUpdatedAt" | "createdAt" | "name" }) => {
		const snapshot = await db().collection(RESUMES).where("userId", "==", input.userId).get();
		const result = snapshot.docs
			.map((document) => document.data() as StoredResume)
			.filter((resume) => input.tags.length === 0 || input.tags.every((tag) => resume.tags.includes(tag)))
			.map(({ data: _data, password: _password, userId: _userId, ownerUsername: _owner, ...resume }) => ({
				...resume,
				createdAt: toDate(resume.createdAt),
				updatedAt: toDate(resume.updatedAt),
			}));
		return result.sort((a, b) => {
			if (input.sort === "name") return a.name.localeCompare(b.name);
			const field = input.sort === "createdAt" ? "createdAt" : "updatedAt";
			return b[field].getTime() - a[field].getTime();
		});
	},
	getById: async ({ id, userId }: { id: string; userId: string }) => publicResume(await loadOwned(id, userId)),
	getBySlug: async (input: {
		username: string;
		slug: string;
		requestHeaders: Headers;
		currentUserId?: string;
		requirePublic?: boolean;
		expectedResumeId?: string;
	}) => {
		const resume = await findBySlug(input.username, input.slug);
		if ((input.requirePublic && !resume.isPublic) || (input.expectedResumeId && resume.id !== input.expectedResumeId))
			throw new ORPCError("NOT_FOUND");
		const viewer = input.currentUserId ? { id: input.currentUserId } : null;
		assertCanView(resume, viewer);
		if (resume.password && !hasResumeAccess(input.requestHeaders, resume.id, resume.password)) {
			throw new ORPCError("NEED_PASSWORD", { status: 401, data: { username: input.username, slug: input.slug } });
		}
		if (shouldCountForStatistics(resume, viewer)) {
			const key = `${resume.id}:${clientKeyFromHeaders(input.requestHeaders)}`;
			if (shouldCountView(key, Date.now())) await statistics.increment({ id: resume.id, views: true });
		}
		const shared = publicResume(resume);
		return redactResumeForViewer(shared, isOwner(resume, viewer));
	},
	create: async (input: {
		id?: string;
		userId: string;
		name: string;
		slug: string;
		tags: string[];
		locale: Locale;
		data?: ResumeData;
	}) => {
		await assertUniqueSlug(input.userId, input.slug);
		const id = input.id ?? generateId();
		const data = parseWritableResumeData(structuredClone(input.data ?? defaultResumeData));
		data.metadata.page.locale = input.locale;
		const now = Timestamp.now();
		const resume: StoredResume = {
			id,
			userId: input.userId,
			ownerUsername: await ownerUsername(input.userId),
			name: input.name,
			slug: input.slug,
			tags: input.tags,
			data,
			isPublic: false,
			isLocked: false,
			showDownloadButtons: true,
			password: null,
			createdAt: now,
			updatedAt: now,
		};
		await ref(id).create(resume);
		await notify(id, input.userId, "create");
		return id;
	},
	update: async (input: {
		id: string;
		userId: string;
		name?: string;
		slug?: string;
		tags?: string[];
		data?: ResumeData;
		isPublic?: boolean;
		showDownloadButtons?: boolean;
		skipAutoSnapshot?: boolean;
	}) => {
		if (input.slug !== undefined) await assertUniqueSlug(input.userId, input.slug, input.id);
		const resume = await db().runTransaction(async (transaction) => {
			const document = await transaction.get(ref(input.id));
			const existing = document.data() as StoredResume | undefined;
			if (!existing || existing.userId !== input.userId) throw new ORPCError("NOT_FOUND");
			if (existing.isLocked) throw new ORPCError("RESUME_LOCKED");
			const updated: StoredResume = {
				...existing,
				...(input.name !== undefined ? { name: input.name } : {}),
				...(input.slug !== undefined ? { slug: input.slug } : {}),
				...(input.tags !== undefined ? { tags: input.tags } : {}),
				...(input.data !== undefined ? { data: parseWritableResumeData(input.data) } : {}),
				...(input.isPublic !== undefined ? { isPublic: input.isPublic } : {}),
				...(input.showDownloadButtons !== undefined ? { showDownloadButtons: input.showDownloadButtons } : {}),
				updatedAt: Timestamp.now(),
			};
			transaction.set(document.ref, updated);
			return updated;
		});
		if (input.data !== undefined && !input.skipAutoSnapshot)
			await snapshotVersion({ resumeId: input.id, userId: input.userId, data: resume.data, label: "Manual save" });
		await notify(input.id, input.userId, "update");
		return publicResume(resume);
	},
	patch: async (input: { id: string; userId: string; operations: JsonPatchOperation[]; expectedUpdatedAt?: Date }) => {
		try {
			const updated = await db().runTransaction(async (transaction) => {
				const document = await transaction.get(ref(input.id));
				const current = document.data() as StoredResume | undefined;
				if (!current || current.userId !== input.userId) throw new ORPCError("NOT_FOUND");
				if (current.isLocked) throw new ORPCError("RESUME_LOCKED");
				if (input.expectedUpdatedAt && toDate(current.updatedAt).getTime() !== input.expectedUpdatedAt.getTime())
					throw new ORPCError("RESUME_VERSION_CONFLICT", { status: 409 });
				const data = parseWritableResumeData(
					applyResumePatches(parseStoredResumeData(current.data), input.operations),
				);
				const next = { ...current, data, updatedAt: Timestamp.now() };
				transaction.set(document.ref, next);
				return next;
			});
			await snapshotVersion({ resumeId: input.id, userId: input.userId, data: updated.data, label: "AI edit" });
			return publicResume(updated);
		} catch (error) {
			if (error instanceof ResumePatchError)
				throw new ORPCError("INVALID_PATCH_OPERATIONS", { status: 400, message: error.message });
			throw error;
		}
	},
	patchInTransaction: () =>
		Promise.reject(
			new ORPCError("NOT_IMPLEMENTED", { message: "Agent transactions are not available with Firestore storage" }),
		),
	notifyResumePatched: async ({ resumeId, userId }: { resumeId: string; userId: string; updatedAt: Date }) =>
		notify(resumeId, userId, "patch"),
	setLocked: async ({ id, userId, isLocked }: { id: string; userId: string; isLocked: boolean }) => {
		await loadOwned(id, userId);
		await ref(id).update({ isLocked, updatedAt: Timestamp.now() });
		await notify(id, userId, "lock");
	},
	setPassword: async ({ id, userId, password }: { id: string; userId: string; password: string }) => {
		await loadOwned(id, userId);
		await ref(id).update({ password: await hash(password, 10), updatedAt: Timestamp.now() });
		await notify(id, userId, "password");
	},
	verifyPassword: async (input: { slug: string; username: string; password: string; responseHeaders?: Headers }) => {
		const resume = await findBySlug(input.username, input.slug);
		if (!resume.password || !(await compare(input.password, resume.password)))
			throw new ORPCError("INVALID_PASSWORD", { status: 401 });
		if (input.responseHeaders) grantResumeAccess(input.responseHeaders, resume.id, resume.password);
		return true;
	},
	removePassword: async ({ id, userId }: { id: string; userId: string }) => {
		await loadOwned(id, userId);
		await ref(id).update({ password: null, updatedAt: Timestamp.now() });
		await notify(id, userId, "password");
	},
	delete: async ({ id, userId }: { id: string; userId: string }) => {
		const resume = await loadOwned(id, userId);
		if (resume.isLocked) throw new ORPCError("RESUME_LOCKED");
		await db().recursiveDelete(ref(id));
		const storage = getStorageService();
		await Promise.allSettled([
			storage.delete(`uploads/${userId}/screenshots/${id}`),
			storage.delete(`uploads/${userId}/pdfs/${id}`),
		]);
		await notify(id, userId, "delete");
	},
};
