import * as THREE from "three";
import React from "react";
import { GizmoHelper, Line } from "@react-three/drei";
import { ViewerContext, ViewerContextContents } from "./ViewerContext";
import { shallowArrayEqual } from "./utils/shallowArrayEqual";

// viser world-axis colors, matching the world-axes frame (see InstancedAxes in
// ThreeAssets.tsx): X red, Y green, Z blue.
const AXIS_COLORS: [string, string, string] = ["#cc0000", "#00cc00", "#0000cc"];
const AXIS_LABELS: [string, string, string] = ["X", "Y", "Z"];

// Pixel size of the gizmo content. The GizmoHelper renders into an orthographic
// scene whose units are roughly pixels, so the axis arms end up ~GIZMO_SCALE
// pixels long.
const GIZMO_SCALE = 28;

/** Snap the camera to look along `direction` (a unit vector in the three.js
 * world frame pointing from the orbit target toward the new camera position).
 *
 * We drive the `camera-controls` instance directly rather than using drei's
 * `GizmoHelper.tweenCamera`: that path is written for OrbitControls and leaves
 * `camera.up` tilted after animating with camera-controls (it only restores up
 * for OrbitControls), which makes camera-controls orbit around a bad up vector
 * afterwards -- the camera ends up off-axis and drifts further on each click.
 *
 * Going through `camera-controls` also means the move animates with the same
 * damping as normal navigation and fires the change events that keep the server
 * camera in sync. */
function snapCameraToDirection(
  viewer: ViewerContextContents,
  direction: THREE.Vector3,
) {
  const cameraControl = viewer.mutable.current.cameraControl;
  if (!cameraControl) return;

  const target = cameraControl.getTarget(new THREE.Vector3());
  const distance = cameraControl.distance;
  const up = cameraControl.camera.up;

  // If we're looking straight along the up axis, the azimuth is degenerate:
  // setLookAt would keep whatever azimuth we had (e.g. the ~45deg initial
  // view), leaving X/Y rotated. Snap the azimuth to the nearest 90deg via
  // rotateTo so top/bottom views land axis-aligned. Keep the world up vector
  // untouched so subsequent orbiting behaves normally.
  if (Math.abs(direction.dot(up)) > 0.999) {
    const polar = direction.dot(up) > 0 ? 0 : Math.PI;
    const quarter = Math.PI / 2;
    const azimuth = Math.round(cameraControl.azimuthAngle / quarter) * quarter;
    cameraControl.rotateTo(azimuth, polar, true);
    return;
  }

  const newPosition = target.clone().addScaledVector(direction, distance);
  cameraControl.setLookAt(
    newPosition.x,
    newPosition.y,
    newPosition.z,
    target.x,
    target.y,
    target.z,
    true,
  );
}

/** Build a circular sprite texture for an axis head. Positive heads are filled
 * with the axis color and carry the axis letter; negative heads are drawn as a
 * hollow ring so the two ends are easy to tell apart. */
function makeAxisTexture(color: string, label: string | null): THREE.Texture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const radius = size / 2 - 3;

  ctx.beginPath();
  ctx.arc(size / 2, size / 2, radius, 0, 2 * Math.PI);
  if (label !== null) {
    // Filled, labeled head.
    ctx.fillStyle = color;
    ctx.fill();
    ctx.font = "bold 34px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#ffffff";
    ctx.fillText(label, size / 2, size / 2 + 2);
  } else {
    // Hollow ring head.
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = color;
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** A single clickable axis head. Clicking snaps the camera to look down the
 * given direction (expressed in the three.js world frame). */
function AxisHead({
  direction,
  texture,
  onSelect,
}: {
  direction: THREE.Vector3;
  texture: THREE.Texture;
  onSelect: (direction: THREE.Vector3) => void;
}) {
  const [hovered, setHovered] = React.useState(false);

  React.useEffect(() => {
    document.body.style.cursor = hovered ? "pointer" : "auto";
    return () => {
      document.body.style.cursor = "auto";
    };
  }, [hovered]);

  return (
    <sprite
      position={direction}
      scale={hovered ? 0.7 : 0.55}
      onPointerDown={(e) => {
        e.stopPropagation();
        onSelect(direction);
      }}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHovered(true);
      }}
      onPointerOut={() => setHovered(false)}
    >
      <spriteMaterial map={texture} transparent toneMapped={false} />
    </sprite>
  );
}

/** Gizmo geometry. Rendered inside GizmoHelper, which counter-rotates this
 * group by the inverse of the main camera each frame so it reads as an
 * orientation indicator.
 *
 * viser exposes a Z-up world to Python while three.js is Y-up; the mapping is
 * the root-node rotation from computeT_threeworld_world. We place each axis at
 * the three.js-world direction of the corresponding viser-world axis, so the
 * labels/colors match the scene's world axes (including signs and arbitrary
 * up-directions set via set_up_direction). These directions are in the
 * three.js-world frame, so feeding them straight to snapCameraToDirection (which
 * also works in that frame) keeps the click navigation consistent with what's
 * drawn. */
function GizmoContent() {
  const viewer = React.useContext(ViewerContext)!;
  // Root rotation, recomputed reactively (set_up_direction can change it).
  const worldRotation = viewer.useSceneTree(
    "",
    (node) => node?.wxyz ?? [1, 0, 0, 0],
    shallowArrayEqual,
  );

  // Axis-head textures depend only on color/label, so build them once.
  const textures = React.useMemo(() => {
    const positive = AXIS_COLORS.map((color, i) =>
      makeAxisTexture(color, AXIS_LABELS[i]),
    );
    const negative = AXIS_COLORS.map((color) => makeAxisTexture(color, null));
    return { positive, negative };
  }, []);
  React.useEffect(() => {
    return () => {
      textures.positive.forEach((t) => t.dispose());
      textures.negative.forEach((t) => t.dispose());
    };
  }, [textures]);

  // viser-world axis directions expressed in the three.js world frame.
  const axes = React.useMemo(() => {
    const R_threeworld_world = new THREE.Quaternion(
      worldRotation[1],
      worldRotation[2],
      worldRotation[3],
      worldRotation[0],
    );
    return [0, 1, 2].map((i) => ({
      direction: new THREE.Vector3(
        i === 0 ? 1 : 0,
        i === 1 ? 1 : 0,
        i === 2 ? 1 : 0,
      )
        .applyQuaternion(R_threeworld_world)
        .normalize(),
      color: AXIS_COLORS[i],
    }));
  }, [worldRotation]);

  const onSelect = React.useCallback(
    (direction: THREE.Vector3) => snapCameraToDirection(viewer, direction),
    [viewer],
  );

  return (
    <group scale={GIZMO_SCALE}>
      {axes.map((axis, i) => (
        <React.Fragment key={i}>
          <Line
            points={[[0, 0, 0], axis.direction.toArray()]}
            color={axis.color}
            lineWidth={2.5}
          />
          <AxisHead
            direction={axis.direction}
            texture={textures.positive[i]}
            onSelect={onSelect}
          />
          <AxisHead
            direction={axis.direction.clone().negate()}
            texture={textures.negative[i]}
            onSelect={onSelect}
          />
        </React.Fragment>
      ))}
    </group>
  );
}

/** Viewport orientation gizmo: an axis triad in the corner of the viewport that
 * snaps the camera to axis-aligned views when clicked. Built on drei's
 * GizmoHelper, which drives the default (camera-controls) instance, so camera
 * state stays in sync with the server. */
export function ViewportGizmo() {
  return (
    <GizmoHelper alignment="bottom-right" margin={[80, 80]}>
      <GizmoContent />
    </GizmoHelper>
  );
}
