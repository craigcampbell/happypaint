import type { ComponentType } from "react";
import { Pressable, StyleSheet, Text, ViewStyle } from "react-native";

type IconProps = {
  size?: number;
  color?: string;
  strokeWidth?: number;
};

type Props = {
  icon: ComponentType<IconProps>;
  label: string;
  onPress: () => void;
  tone?: "light" | "dark" | "danger" | "premium";
  disabled?: boolean;
  style?: ViewStyle;
};

export function IconButton({ icon: Icon, label, onPress, tone = "light", disabled, style }: Props) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        styles[tone],
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
        style
      ]}
    >
      <Icon size={18} color={tone === "dark" ? "#ffffff" : "#1f2937"} strokeWidth={2.4} />
      <Text style={[styles.label, tone === "dark" && styles.darkLabel]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: "center",
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    gap: 7,
    minHeight: 42,
    paddingHorizontal: 12
  },
  dark: {
    backgroundColor: "#111827",
    borderColor: "#111827"
  },
  danger: {
    backgroundColor: "#fee2e2",
    borderColor: "#fecaca"
  },
  darkLabel: {
    color: "#ffffff"
  },
  disabled: {
    opacity: 0.45
  },
  label: {
    color: "#1f2937",
    fontSize: 14,
    fontWeight: "700"
  },
  light: {
    backgroundColor: "#ffffff",
    borderColor: "#d1d5db"
  },
  premium: {
    backgroundColor: "#fef3c7",
    borderColor: "#f59e0b"
  },
  pressed: {
    transform: [{ scale: 0.98 }]
  }
});
