import {
	App,
	normalizePath,
	PluginSettingTab,
	Setting,
	type SettingDefinitionItem,
} from "obsidian";
import OKRPlugin from "../main";
import type { OKRPeriodType, OKRPluginSettings } from "../types";

type SettingsKey = keyof OKRPluginSettings;

export class SettingsTab extends PluginSettingTab {
	plugin: OKRPlugin;

	constructor(app: App, plugin: OKRPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem<SettingsKey>[] {
		const t = this.plugin.i18n.t;
		return [
			{
				name: t("settings.rootDir.name"),
				desc: t("settings.rootDir.desc"),
				control: {
					type: "text",
					key: "rootDir",
					placeholder: "OKR",
				},
			},
			{
				name: t("settings.defaultPeriodType.name"),
				desc: t("settings.defaultPeriodType.desc"),
				control: {
					type: "dropdown",
					key: "defaultPeriodType",
					options: {
						week: t("modals.select.week"),
						month: t("modals.select.month"),
						quarter: t("modals.select.quarter"),
						year: t("modals.select.year"),
					},
				},
			},
			{
				name: t("settings.autoComputeProgress.name"),
				desc: t("settings.autoComputeProgress.desc"),
				control: { type: "toggle", key: "autoComputeProgress" },
			},
			{
				name: t("settings.showDashboardOnStartup.name"),
				control: { type: "toggle", key: "showDashboardOnStartup" },
			},
			{
				name: "HTTP API / MCP",
				desc: "在 127.0.0.1 上暴露 OKR 工具，供 MCP 客户端调用。仅桌面端可用。",
				control: { type: "toggle", key: "enableMCP" },
			},
			{
				name: "MCP 端口",
				desc: "默认 8090，需与客户端配置一致。",
				control: { type: "text", key: "mcpPort", placeholder: "8090" },
			},
			{
				name: "MCP Token",
				desc: "客户端需发送 Authorization: Bearer <token>。留空则启动时自动生成。",
				control: { type: "text", key: "mcpAuthToken", placeholder: "留空自动生成" },
			},
		];
	}

	getControlValue(key: string): unknown {
		if (!this.isSettingsKey(key)) {
			return undefined;
		}
		return this.plugin.settings[key];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		if (!this.isSettingsKey(key)) {
			return;
		}

		switch (key) {
			case "rootDir":
				if (typeof value !== "string") {
					return;
				}
				this.plugin.settings.rootDir = normalizePath(value.trim() || "OKR");
				break;
			case "defaultPeriodType":
				if (!this.isPeriodType(value)) {
					return;
				}
				this.plugin.settings.defaultPeriodType = value;
				break;
			case "autoComputeProgress":
			case "showDashboardOnStartup":
			case "enableMCP":
				if (typeof value !== "boolean") {
					return;
				}
				this.plugin.settings[key] = value;
				break;
			case "mcpPort": {
				const port = Number(value);
				if (!Number.isInteger(port) || port < 1024 || port > 65535) {
					return;
				}
				this.plugin.settings.mcpPort = port;
				break;
			}
			case "mcpAuthToken":
				if (typeof value !== "string") {
					return;
				}
				this.plugin.settings.mcpAuthToken = value.trim();
				break;
		}
		await this.plugin.saveSettings();
		// 端口、Token、开关变化后重建服务
		if (key === "enableMCP" || key === "mcpPort" || key === "mcpAuthToken") {
			await this.plugin.restartMCP();
		}
	}

	display(): void {
		const { containerEl } = this;
		const t = this.plugin.i18n.t;
		containerEl.empty();
		new Setting(containerEl)
			.setName(t("settings.rootDir.name"))
			.setDesc(t("settings.rootDir.desc"))
			.addText((text) =>
				text
					.setPlaceholder("OKR")
					.setValue(this.plugin.settings.rootDir)
					.onChange(async (value) => {
						this.plugin.settings.rootDir = normalizePath(
							value.trim() || "OKR",
						);
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(t("settings.defaultPeriodType.name"))
			.setDesc(t("settings.defaultPeriodType.desc"))
			.addDropdown((dropdown) =>
				dropdown
					.addOption("week", t("modals.select.week"))
					.addOption("month", t("modals.select.month"))
					.addOption("quarter", t("modals.select.quarter"))
					.addOption("year", t("modals.select.year"))
					.setValue(this.plugin.settings.defaultPeriodType)
					.onChange(async (value) => {
						this.plugin.settings.defaultPeriodType =
							value as typeof this.plugin.settings.defaultPeriodType;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(t("settings.autoComputeProgress.name"))
			.setDesc(t("settings.autoComputeProgress.desc"))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoComputeProgress)
					.onChange(async (value) => {
						this.plugin.settings.autoComputeProgress = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName(t("settings.showDashboardOnStartup.name"))
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showDashboardOnStartup)
					.onChange(async (value) => {
						this.plugin.settings.showDashboardOnStartup = value;
						await this.plugin.saveSettings();
					}),
			);
	}

	private isSettingsKey(key: string): key is SettingsKey {
		return [
			"rootDir",
			"defaultPeriodType",
			"autoComputeProgress",
			"showDashboardOnStartup",
			"enableMCP",
			"mcpPort",
			"mcpAuthToken",
		].includes(key);
	}

	private isPeriodType(value: unknown): value is OKRPeriodType {
		return (
			typeof value === "string" &&
			["week", "month", "quarter", "year"].includes(value)
		);
	}
}
