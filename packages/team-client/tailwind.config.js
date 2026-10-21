/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{html,js,svelte,ts}"],
  darkMode: ["selector", '[data-theme="dark"]'],
  theme: {
    zIndex: {
      none: 0,
      "nav-active": 1,
      "nav-item": 2,
      feature: 3,
      compose: 4,
      nav: 5,
      popover: 6,
      modal: 7,
      tooltip: 8,
      toast: 9,
    },
  },
  plugins: [],
}
