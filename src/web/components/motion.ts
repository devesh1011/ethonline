"use client";

import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import type { RefObject } from "react";

gsap.registerPlugin(useGSAP);
export { gsap, useGSAP };

/** Tactile feedback only: never changes the click, submission or wallet handler. */
export function usePressFeedback(root: RefObject<HTMLElement | null>) {
  useGSAP((_context, contextSafe) => {
    const element = root.current;
    if (!element || !contextSafe) return;
    const media = gsap.matchMedia();
    media.add("(prefers-reduced-motion: no-preference)", () => {
      const touched = new Set<HTMLElement>();
      let pressed: HTMLElement | null = null;
      const release = contextSafe(() => {
        if (pressed?.isConnected) gsap.to(pressed, { y: 0, scale: 1, duration: 0.2, ease: "power3.out", overwrite: "auto", clearProps: "transform" });
        pressed = null;
      });
      const press = contextSafe((event: Event) => {
        if (event instanceof KeyboardEvent && !["Enter", " "].includes(event.key)) return;
        const target = event.target instanceof Element ? event.target.closest<HTMLElement>('button:not(:disabled):not([data-press-feedback="none"]), a[data-press]') : null;
        if (!target || target.getAttribute("aria-disabled") === "true") return;
        release(); pressed = target; touched.add(target);
        gsap.to(target, { y: 2, scale: 0.975, duration: 0.11, ease: "power2.out", overwrite: "auto" });
      });
      element.addEventListener("pointerdown", press);
      element.addEventListener("keydown", press);
      window.addEventListener("pointerup", release);
      window.addEventListener("pointercancel", release);
      window.addEventListener("blur", release);
      element.addEventListener("keyup", release);
      return () => {
        element.removeEventListener("pointerdown", press);
        element.removeEventListener("keydown", press);
        window.removeEventListener("pointerup", release);
        window.removeEventListener("pointercancel", release);
        window.removeEventListener("blur", release);
        element.removeEventListener("keyup", release);
        touched.forEach(target => { gsap.killTweensOf(target); gsap.set(target, { clearProps: "transform" }); });
      };
    });
    return () => media.revert();
  }, { scope: root });
}
