import pandas as pd
import numpy as np
from pathlib import Path

DATA_DIR = Path("data")
OUTPUT_DIR = Path("outputs")
OUTPUT_DIR.mkdir(exist_ok=True)

tool_file = DATA_DIR / "S&OP_Tool_Displayed_Data.csv"
sales_file = DATA_DIR / "Underlying_SalesDocuments.csv"

tool_df = pd.read_csv(tool_file)
sales_df = pd.read_csv(sales_file)

def clean_column_names(df):
    df.columns = (
        df.columns
        .str.strip()
        .str.lower()
        .str.replace(" ", "_")
        .str.replace("&", "and")
    )
    return df

def convert_comma_numbers(series):
    return (
        series.astype(str)
        .str.replace(",", ".", regex=False)
        .replace("nan", np.nan)
        .astype(float)
    )

tool_df = clean_column_names(tool_df)
sales_df = clean_column_names(sales_df)

# Convert dates
tool_df["date"] = pd.to_datetime(tool_df["date"], errors="coerce")
sales_df["date"] = pd.to_datetime(sales_df["date"], errors="coerce")

# Convert numeric columns stored as text with comma decimals
tool_numeric_cols = [
    col for col in tool_df.columns
    if "tons" in col
]

for col in tool_numeric_cols:
    tool_df[col] = convert_comma_numbers(tool_df[col])

sales_df["quantity_in_kg"] = convert_comma_numbers(sales_df["quantity_in_kg"])

# Remove duplicates
tool_df = tool_df.drop_duplicates()
sales_df = sales_df.drop_duplicates()

# Handle missing values
sales_df["recipient_postal_code"] = sales_df["recipient_postal_code"].fillna("Unknown")
sales_df["recipient_country"] = sales_df["recipient_country"].fillna("Unknown")

# Convert flag columns to boolean
sales_df["is_contract"] = sales_df["is_contract"].astype(bool)
sales_df["is_scheduling_agreement"] = sales_df["is_scheduling_agreement"].astype(bool)

# Add useful feature
sales_df["quantity_in_tons"] = sales_df["quantity_in_kg"] / 1000

# Save cleaned files
tool_df.to_csv(OUTPUT_DIR / "cleaned_sop_tool_data.csv", index=False)
sales_df.to_csv(OUTPUT_DIR / "cleaned_sales_documents.csv", index=False)

print("Data cleaning completed.")
print("S&OP Tool Data:", tool_df.shape)
print("Sales Documents:", sales_df.shape)
print("Cleaned files saved in outputs folder.")