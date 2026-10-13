import { icons } from "./icons";

/** The Spinner view (Views.swift) at `size` px. */
export const spinner = (size = 22) => `<span class="spinner" style="--s:${size}px"><span class="eye">${icons.eye}</span></span>`;
