/**
 * Biometrics, as a stand-in for POAP's own passcode: Face ID or Touch ID on an
 * iPhone, fingerprint or face unlock on Android. Never the phone's own
 * passcode — when biometrics fail or are cancelled, the app asks for its own
 * passcode instead, so knowing the phone's code is not enough to open the
 * wallet.
 */
import * as LocalAuthentication from "expo-local-authentication";
import { Platform } from "react-native";

const { AuthenticationType: Type, SecurityLevel: Level } = LocalAuthentication;

/**
 * The biometric this phone has set up, in its own words ("Face ID",
 * "Fingerprint"), or null when there is none to use.
 */
export async function biometricMethod(): Promise<string | null> {
  try {
    const level = await LocalAuthentication.getEnrolledLevelAsync();
    if (level !== Level.BIOMETRIC_STRONG && level !== Level.BIOMETRIC_WEAK) return null;
    const ios = Platform.OS === "ios";
    const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
    if (types.includes(Type.FACIAL_RECOGNITION) && !types.includes(Type.FINGERPRINT)) return ios ? "Face ID" : "Face unlock";
    if (types.includes(Type.FINGERPRINT) && !types.includes(Type.FACIAL_RECOGNITION)) return ios ? "Touch ID" : "Fingerprint";
    if (types.includes(Type.IRIS) && types.length === 1) return "Iris";
    return ios ? "Face ID" : "Biometrics";
  } catch {
    return null;
  }
}

/** True once biometrics match; false if they fail, are cancelled, or the passcode is asked for instead. */
export async function confirmBiometric(reason: string): Promise<boolean> {
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: reason,
      cancelLabel: "Cancel",
      fallbackLabel: "Use passcode",
      disableDeviceFallback: true,
    });
    return result.success;
  } catch {
    return false;
  }
}
