import * as React from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { GeoPoint } from "@beamhop/sdk/admin-contract";
import { useTheme } from "@/lib/theme";
import { formatNumber } from "@/lib/format";

const TILES = "https://demotiles.maplibre.org/tiles/tiles.json";

function buildStyle(dark: boolean, points: GeoPoint[], metric: "connections" | "events"): maplibregl.StyleSpecification {
  const max = Math.max(1, ...points.map((p) => p[metric]));
  const byName = new Map<string, number>();
  for (const p of points) byName.set(p.countryName, (byName.get(p.countryName) ?? 0) + p[metric]);
  const land = dark ? "#27272a" : "#e4e4e7";
  const hot = dark ? "#7c3aed" : "#8b5cf6";
  const fillColor: maplibregl.ExpressionSpecification | string = byName.size
    ? ([
        "match",
        ["get", "NAME"],
        ...[...byName].flatMap(([name, v]) => [name, mix(land, hot, 0.2 + 0.6 * Math.sqrt(v / max))]),
        land,
      ] as unknown as maplibregl.ExpressionSpecification)
    : land;
  return {
    version: 8,
    sources: { maplibre: { type: "vector", url: TILES } },
    layers: [
      { id: "background", type: "background", paint: { "background-color": dark ? "#111113" : "#f8fafc" } },
      { id: "countries-fill", type: "fill", source: "maplibre", "source-layer": "countries", paint: { "fill-color": fillColor } },
      {
        id: "countries-boundary",
        type: "line",
        source: "maplibre",
        "source-layer": "countries",
        paint: { "line-color": dark ? "#3f3f46" : "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 1, 0.4, 6, 1.2] },
      },
    ],
  };
}

function mix(a: string, b: string, t: number) {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return `#${pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, "0")).join("")}`;
}

type FeatureCollection = Extract<Parameters<maplibregl.GeoJSONSource["setData"]>[0], { type: "FeatureCollection" }>;

function toGeoJson(points: GeoPoint[]): FeatureCollection {
  return {
    type: "FeatureCollection",
    features: points.map((p, i) => ({
      type: "Feature",
      id: i,
      geometry: { type: "Point", coordinates: [p.lon, p.lat] },
      properties: { ...p, label: p.city ? `${p.city}, ${p.countryName}` : p.countryName },
    })),
  };
}

export default function WorldMap({ points, metric = "connections", className }: { points: GeoPoint[]; metric?: "connections" | "events"; className?: string }) {
  const el = React.useRef<HTMLDivElement>(null);
  const map = React.useRef<maplibregl.Map | null>(null);
  const { resolved } = useTheme();
  const dark = resolved === "dark";
  const latest = React.useRef({ points, metric });
  latest.current = { points, metric };

  const addPoints = React.useCallback((m: maplibregl.Map) => {
    const { points, metric } = latest.current;
    const max = Math.max(1, ...points.map((p) => p[metric]));
    const data = toGeoJson(points);
    const src = m.getSource("points") as maplibregl.GeoJSONSource | undefined;
    if (src) src.setData(data);
    else m.addSource("points", { type: "geojson", data });
    const radius: maplibregl.ExpressionSpecification = ["+", 4, ["*", 22, ["sqrt", ["/", ["get", metric], max]]]];
    if (!m.getLayer("points-glow")) {
      m.addLayer({ id: "points-glow", type: "circle", source: "points", paint: { "circle-radius": ["*", 1.8, radius], "circle-color": "#8b5cf6", "circle-opacity": 0.15, "circle-blur": 0.6 } });
      m.addLayer({
        id: "points",
        type: "circle",
        source: "points",
        paint: { "circle-radius": radius, "circle-color": "#8b5cf6", "circle-opacity": 0.75, "circle-stroke-color": "#ffffff", "circle-stroke-width": 1 },
      });
    } else {
      m.setPaintProperty("points", "circle-radius", radius);
      m.setPaintProperty("points-glow", "circle-radius", ["*", 1.8, radius]);
    }
  }, []);

  React.useEffect(() => {
    if (!el.current) return;
    const m = new maplibregl.Map({
      container: el.current,
      style: buildStyle(dark, latest.current.points, latest.current.metric),
      center: [10, 25],
      zoom: 0.6,
      minZoom: 0,
      maxZoom: 6,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      cooperativeGestures: true,
      renderWorldCopies: false,
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    m.touchZoomRotate.disableRotation();
    const popup = new maplibregl.Popup({ closeButton: false, offset: 10 });
    m.on("load", () => addPoints(m));
    m.on("styledata", () => {
      if (m.isStyleLoaded() && !m.getSource("points")) addPoints(m);
    });
    m.on("mouseenter", "points", () => (m.getCanvas().style.cursor = "pointer"));
    m.on("mouseleave", "points", () => (m.getCanvas().style.cursor = ""));
    m.on("click", "points", (e) => {
      const f = e.features?.[0];
      if (!f) return;
      const p = f.properties as Record<string, string | number>;
      const div = document.createElement("div");
      div.className = "space-y-0.5 p-0.5";
      const title = document.createElement("div");
      title.className = "font-semibold";
      title.textContent = String(p.label);
      const stats = document.createElement("div");
      stats.textContent = `${formatNumber(Number(p.connections))} connections · ${formatNumber(Number(p.events))} events`;
      div.append(title, stats);
      popup.setLngLat((f.geometry as unknown as { coordinates: [number, number] }).coordinates).setDOMContent(div).addTo(m);
    });
    map.current = m;
    const ro = new ResizeObserver(() => m.resize());
    ro.observe(el.current);
    return () => {
      ro.disconnect();
      m.remove();
      map.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    const m = map.current;
    if (!m) return;
    m.setStyle(buildStyle(dark, points, metric));
    // setStyle drops custom layers; they're re-added on styledata
  }, [dark, points, metric]);

  return <div ref={el} className={className ?? "h-80 w-full overflow-hidden rounded-lg"} />;
}
