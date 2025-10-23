
export function setupDebugTrigger(scene){
     scene.onKeyboardObservable.add((kbInfo) => {
        let {key, ctrlKey, altKey, shiftKey} = kbInfo.event
    switch (kbInfo.type) {
        case BABYLON.KeyboardEventTypes.KEYDOWN:
            if (kbInfo.event.key == "i"){
{
            if (scene.debugLayer.isVisible()) {
          scene.debugLayer.hide()
        } else {
          scene.debugLayer.show()
        }
            }
        
    }
        break;
        case BABYLON.KeyboardEventTypes.KEYUP:
        console.log("KEY UP: ", kbInfo.event.code);
        break;
    }
    });
}