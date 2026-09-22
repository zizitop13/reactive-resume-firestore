import { Trans } from "@lingui/react/macro";
import { m } from "motion/react";
import { isFirebaseEnabled } from "@/libs/auth/firebase";
import { useEnabledProviders } from "./components/hooks";
import { PasskeysSection } from "./components/passkeys";
import { PasswordSection } from "./components/password";
import { SocialProviderSection } from "./components/social-provider";
import { TwoFactorSection } from "./components/two-factor";

export function AuthenticationSettingsPage() {
	const { enabledProviders } = useEnabledProviders();
	if (isFirebaseEnabled) {
		return (
			<p className="text-muted-foreground">
				<Trans>Authentication is managed by Firebase for this instance.</Trans>
			</p>
		);
	}

	return (
		<m.div
			initial={{ y: -20 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{ duration: 0.25, ease: "easeOut" }}
			className="grid max-w-xl gap-4 will-change-[transform,opacity]"
		>
			<PasswordSection />

			<TwoFactorSection />

			<PasskeysSection />

			{"google" in enabledProviders && <SocialProviderSection provider="google" animationDelay={0.04} />}

			{"github" in enabledProviders && <SocialProviderSection provider="github" animationDelay={0.08} />}

			{"linkedin" in enabledProviders && <SocialProviderSection provider="linkedin" animationDelay={0.12} />}

			{"custom" in enabledProviders && (
				<SocialProviderSection provider="custom" animationDelay={0.16} name={enabledProviders.custom} />
			)}
		</m.div>
	);
}
