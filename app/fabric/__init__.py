"""Platform-neutral action fabric for Magic Pointer."""

from app.fabric.catalog import RECIPE_CATALOG, get_recipe, public_recipe_catalog
from app.fabric.router import RecipeRouter

__all__ = ["RECIPE_CATALOG", "RecipeRouter", "get_recipe", "public_recipe_catalog"]

