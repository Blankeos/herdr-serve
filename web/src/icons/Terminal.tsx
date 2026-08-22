import { type JSX } from "solid-js";

export default function IconTerminal(props: JSX.SvgSVGAttributes<SVGSVGElement>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true" {...props}>
      <g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2">
        <path d="m7.5 9.5l2.5 2.5l-2.5 2.5" />
        <path d="M12 14h5" />
        <rect width="18" height="16" x="3" y="4" rx="2" />
      </g>
    </svg>
  );
}
