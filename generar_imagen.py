import sys, json, os, base64
from pathlib import Path

prompt = sys.argv[1]
tarea_id = sys.argv[2]

# Crear carpeta de salida
os.makedirs("generaciones", exist_ok=True)

try:
    import torch
    from diffusers import StableDiffusionPipeline

    # Usar modelo ligero (descarga automática la primera vez)
    model_id = "nota-ai/bk-sdm-small"  # 1 GB, optimizado para CPU
    pipe = StableDiffusionPipeline.from_pretrained(
        model_id,
        torch_dtype=torch.float32,
        safety_checker=None,
        requires_safety_checker=False
    )
    # Forzar CPU
    pipe = pipe.to("cpu")
    # Generar
    image = pipe(prompt, num_inference_steps=15, guidance_scale=7.0).images[0]
    # Guardar temporalmente y convertir a base64
    tmp_path = f"generaciones/{tarea_id}.png"
    image.save(tmp_path)
    with open(tmp_path, "rb") as f:
        base64_img = base64.b64encode(f.read()).decode("utf-8")
    # Guardar resultado
    with open(f"generaciones/{tarea_id}.json", "w") as f:
        json.dump({"imagen": f"data:image/png;base64,{base64_img}"}, f)
    print(f"✅ Imagen generada: {tarea_id}")
except Exception as e:
    with open(f"generaciones/{tarea_id}.json", "w") as f:
        json.dump({"error": str(e)}, f)
    print(f"❌ Error: {e}")
