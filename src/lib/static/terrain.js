import { StaticEntity } from '@/lib/entity';
import { emitRockIco } from '@/lib/geometry/emitters';
import { Animate } from '@/lib/plants/classes';
import { Color4, Scalar, Vector3 } from '@babylonjs/core';
export class Rock extends StaticEntity {
    constructor(scene, pos, params = {}) {
        super(scene, pos, params);
        const A = Animate;
        const MAT = window.GLOBAL_CACHE.MAT;

        // 🪨 Less variation in number and size (≈⅓ overall)
        const count = params.count ?? 1 + Math.floor(Math.random() * 2);
        const baseSize = params.size ?? Scalar.Lerp(0.1, 0.3, Math.random()); // smaller base scale

        for (let i = 0; i < count; i++) {
            const tint = new Color4(0.18 + Math.random() * 0.25, 0.18 + Math.random() * 0.25, 0.18 + Math.random() * 0.25, 1);

            const rock = emitRockIco(scene, MAT.rock, {
                radius: baseSize * (0.8 + Math.random() * 0.8), // narrower radius range
                roughness: 0.18 + Math.random() * 0.12,
                cragginess: 0.18 + Math.random() * 0.15,
                dentStrength: 0.06 + Math.random() * 0.07,
                dentSpread: 0.7 + Math.random() * 0.4,
                flattenY: 0.1 + Math.random() * 0.15,
                tint
            });

            this.add(rock, MAT.rock);
            rock.position = new Vector3((Math.random() - 0.5) * 0.6, 0, (Math.random() - 0.5) * 0.6);
            rock.rotation.set(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI);
            rock.scaling.setAll(0);
            A.popScale(rock, 18, Math.random() * 150, 'easeOutBack');
        }

        this.finalize();
    }
}
