import type { AppContext } from "../../../app/context.js";
import { now } from "../../../shared/utilities/util.js";
import { INVENTORY,applySlot } from "./service.js";
import { styleOf } from "../profileMedia.js";
export async function fulfillCollectiblePayment(ctx:AppContext,r:{id:string;status:string;user_id:string|null;item_id:string;amount_minor:number;currency:string;payment_ref:string|null}){const source="purchase:"+r.id;
        await ctx.identity.write((w) => {
          if (r.status === "paid") {
            if (!w.get("users", { id: r.user_id })) return;
            if (
              !w.get(INVENTORY, {
                user_id: r.user_id,
                decoration_id: r.item_id,
              })
            ) {
              w.insert(INVENTORY, {
                user_id: r.user_id,
                decoration_id: r.item_id,
                acquisition_source: source,
                acquired_at: now(),
                is_favorite: 0,
              });
              const previous = w.get<{ id: string }>(
                "profile_collectible_transactions",
                { user_id: r.user_id, decoration_id: r.item_id },
              );
              const receipt = {
                transaction_type: "purchase",
                price: r.amount_minor,
                currency: r.currency,
                payment_reference: r.payment_ref,
                created_at: now(),
              };
              if (previous)
                w.update(
                  "profile_collectible_transactions",
                  { id: previous.id },
                  receipt,
                );
              else
                w.insert("profile_collectible_transactions", {
                  id: r.id,
                  user_id: r.user_id,
                  decoration_id: r.item_id,
                  ...receipt,
                });
            }
          } else {
            const removed = w.delete(INVENTORY, {
              user_id: r.user_id,
              decoration_id: r.item_id,
              acquisition_source: source,
            });
            if (removed) {
              const u = w.get<{ profile_style: string | null }>("users", {
                id: r.user_id,
              });
              if (u) {
                let style = styleOf(u);
                for (const look of style.collectibles ?? [])
                  if (look.id === r.item_id)
                    style = applySlot(style, look.category, null);
                w.update(
                  "users",
                  { id: r.user_id },
                  { profile_style: JSON.stringify(style), updated_at: now() },
                );
              }
              w.update(
                "profile_collectible_transactions",
                {
                  user_id: r.user_id,
                  decoration_id: r.item_id,
                  payment_reference: r.payment_ref,
                },
                { transaction_type: r.status },
              );
            }
          }
        });
}
